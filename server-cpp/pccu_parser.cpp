// pccu_parser.cpp
// 解析文大兩個頁面（已登入後取得的 HTML），輸出 JSON：
//   1. 學生課表查詢（週課表格狀表格）→ 每堂課的星期、起訖時間、教室
//   2. 課業輔導系統首頁 → 課程清單、最新公告（含未讀）、最新作業
//
// 不依賴任何第三方套件（C++17 標準函式庫），用字串掃描而非 regex，
// 因為實際頁面含大量內嵌 CSS，std::regex 在大字串上容易堆疊溢位。
//
// 編譯：g++ -std=c++17 -Wall -Wextra -O2 pccu_parser.cpp -o pccu_parser
// 用法：
//   ./pccu_parser schedule  課表.html
//   ./pccu_parser dashboard 首頁.html
//   ./pccu_parser import    課表.html 首頁.html   # 產生 PWA 可匯入的 JSON
//
// 隱私：頁面中的學生姓名、學號不會被讀取或輸出。

#include <algorithm>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <sstream>
#include <set>
#include <cstdint>
#include <string>
#include <vector>

using std::string;
using std::vector;

// ---------- 字串工具 ----------

static string readFile(const string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("無法開啟檔案：" + path);
    std::ostringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

static string replaceAll(string s, const string& from, const string& to) {
    if (from.empty()) return s;
    size_t pos = 0;
    while ((pos = s.find(from, pos)) != string::npos) {
        s.replace(pos, from.size(), to);
        pos += to.size();
    }
    return s;
}

static string decodeEntities(string s) {
    s = replaceAll(s, "&nbsp;", " ");
    s = replaceAll(s, "\xC2\xA0", " ");
    s = replaceAll(s, "&lt;", "<");
    s = replaceAll(s, "&gt;", ">");
    s = replaceAll(s, "&quot;", "\"");
    s = replaceAll(s, "&#39;", "'");
    s = replaceAll(s, "&amp;", "&");  // 最後處理，避免二次解碼
    return s;
}

static string stripTags(const string& in) {
    string s = replaceAll(replaceAll(in, "<br>", " "), "<br/>", " ");
    string out;
    bool inTag = false;
    for (char c : s) {
        if (c == '<') inTag = true;
        else if (c == '>') inTag = false;
        else if (!inTag) out += c;
    }
    return out;
}

// 去頭尾空白並把連續空白壓成一個空格
static string collapse(const string& in) {
    string out;
    bool space = false;
    for (unsigned char c : in) {
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') { space = true; continue; }
        if (space && !out.empty()) out += ' ';
        space = false;
        out += static_cast<char>(c);
    }
    return out;
}

// 移除 <script>…</script>、<style>…</style>：程式碼裡的字串（例如範本）可能含有和資料相同的 class 名稱
static string stripBlocks(const string& html) {
    string out;
    out.reserve(html.size());
    size_t pos = 0;
    while (pos < html.size()) {
        size_t a = string::npos;
        string closeTag;
        for (const string& tag : {string("script"), string("style")}) {
            size_t p = pos;
            while ((p = html.find("<" + tag, p)) != string::npos) {
                char c = p + 1 + tag.size() < html.size() ? html[p + 1 + tag.size()] : '>';
                if (c == '>' || c == ' ' || c == '\t' || c == '\n' || c == '\r') break;  // 避免把 <scripts> 之類誤判
                ++p;
            }
            if (p != string::npos && p < a) { a = p; closeTag = "</" + tag + ">"; }
        }
        if (a == string::npos) { out.append(html, pos, string::npos); break; }
        out.append(html, pos, a - pos);
        size_t b = html.find(closeTag, a);
        pos = b == string::npos ? html.size() : b + closeTag.size();
    }
    return out;
}

static string text(const string& html) { return collapse(decodeEntities(stripTags(html))); }

static vector<string> splitWords(const string& s) {
    vector<string> w;
    std::istringstream ss(s);
    string t;
    while (ss >> t) w.push_back(t);
    return w;
}

static bool isAsciiAlnum(const string& s) {
    return !s.empty() && std::all_of(s.begin(), s.end(), [](unsigned char c) { return std::isalnum(c) != 0; });
}

// 取得 s 中 [open, close) 之間的內容；找不到回傳 false
static bool between(const string& s, const string& open, const string& close, size_t from, string& out, size_t* endPos = nullptr) {
    size_t a = s.find(open, from);
    if (a == string::npos) return false;
    a += open.size();
    size_t b = s.find(close, a);
    if (b == string::npos) return false;
    out = s.substr(a, b - a);
    if (endPos) *endPos = b + close.size();
    return true;
}

// 取得所有 <td ...>內容</td>
static vector<string> cellsOf(const string& row) {
    vector<string> cells;
    size_t pos = 0;
    while ((pos = row.find("<td", pos)) != string::npos) {
        size_t gt = row.find('>', pos);
        if (gt == string::npos) break;
        size_t end = row.find("</td>", gt);
        if (end == string::npos) break;
        cells.push_back(row.substr(gt + 1, end - gt - 1));
        pos = end + 5;
    }
    return cells;
}

// ---------- JSON 輸出 ----------

static string jstr(const string& s) {
    string o = "\"";
    for (unsigned char c : s) {
        switch (c) {
            case '"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
                else o += static_cast<char>(c);
        }
    }
    return o + "\"";
}

// ---------- 學期 ----------

// "1151" → "115-1"
static string semesterFromCode(const string& code) {
    if (code.size() < 3) return code;
    return code.substr(0, code.size() - 1) + "-" + code.back();
}

// ---------- 教室 ----------

// "大義      0721" → "大義館 0721"；空字串代表頁面沒有標示教室（例如體育課）
static string normalizeRoom(const string& raw) {
    string r = collapse(raw);
    if (r.empty()) return "";
    auto w = splitWords(r);
    string building = w[0];
    static const string kan = "館";
    if (w.size() >= 2 && building.size() >= kan.size() &&
        building.compare(building.size() - kan.size(), kan.size(), kan) != 0)
        building += kan;
    string out = building;
    for (size_t i = 1; i < w.size(); ++i) out += " " + w[i];
    return out;
}

// ============================================================
// 學生課表查詢
// ============================================================

struct Block {
    int weekday = 0;  // 0=週日 … 6=週六（同 JavaScript getDay）
    string start, end;
    int lastPeriod = 0;
    string kind, dept, code, name, section, teacher, room, ccode;
};

struct ScheduleResult {
    string semester;
    vector<Block> blocks;
};

struct CellCourse {
    string kind, dept, code, name, section, teacher, room, ccode;
};

// 解析課名那一行："(必) 資工系  2A  6277 機率與統計"、"(必) 體育 0 9008 體育：桌球 (01)"
// 欄位數量不固定，所以以「第一個 3 碼以上的英數字」當課號。
static void parseCourseLine(const string& line, CellCourse& c) {
    auto w = splitWords(line);
    size_t i = 0;
    if (!w.empty() && w[0].size() >= 3 && w[0].front() == '(') {
        // "(必)" → "必"；注意中文字佔 3 位元組，所以不能用固定長度切
        size_t close = w[0].find(')');
        if (close != string::npos) c.kind = w[0].substr(1, close - 1);
        i = 1;
    }
    if (i < w.size()) c.dept = w[i++];
    size_t codeAt = w.size();
    for (size_t j = i; j < w.size(); ++j) {
        if (w[j].size() >= 3 && isAsciiAlnum(w[j])) { codeAt = j; break; }
    }
    if (codeAt < w.size()) {
        c.code = w[codeAt];
        i = codeAt + 1;
    }
    string name;
    for (size_t j = i; j < w.size(); ++j) name += (name.empty() ? "" : " ") + w[j];
    // 結尾的 "(01)" 是班別
    size_t lp = name.rfind('(');
    if (lp != string::npos && name.size() - lp <= 5 && name.back() == ')') {
        string inner = name.substr(lp + 1, name.size() - lp - 2);
        if (!inner.empty() && std::all_of(inner.begin(), inner.end(), [](unsigned char ch) { return std::isdigit(ch) != 0; })) {
            c.section = inner;
            name = collapse(name.substr(0, lp));
        }
    }
    c.name = name;
}

static vector<CellCourse> parseCell(const string& cell) {
    vector<CellCourse> out;
    // 實際頁面的標籤屬性很多：<a title=".." href=".." class="red" target="_blank"><font color="#CC3300">…
    // 所以用 class="red" 當每堂課的起點，不假設屬性順序。
    const string marker = "class=\"red\"";
    size_t pos = 0;
    while ((pos = cell.find(marker, pos)) != string::npos) {
        size_t next = cell.find(marker, pos + marker.size());
        string seg = cell.substr(pos, next == string::npos ? string::npos : next - pos);
        size_t tagStart = cell.rfind("<a ", pos);
        string tag = tagStart == string::npos ? "" : cell.substr(tagStart, pos - tagStart);
        pos = (next == string::npos) ? cell.size() : next;

        CellCourse c;
        // 連結裡有課輔系統的課程代碼（...ccode%3D405894...），之後可用來對應作業與公告
        size_t cc = tag.find("ccode%3D");
        if (cc == string::npos) cc = tag.find("ccode=");
        if (cc != string::npos) {
            cc = tag.find_first_of("D=", cc + 5) + 1;
            while (cc < tag.size() && std::isdigit(static_cast<unsigned char>(tag[cc]))) c.ccode += tag[cc++];
        }

        // 課名：<font color="#CC3300">…</font>
        size_t f0 = seg.find("<font");
        if (f0 == string::npos) continue;
        size_t gt0 = seg.find('>', f0);
        size_t fe0 = seg.find("</font>", gt0);
        if (gt0 == string::npos || fe0 == string::npos) continue;
        parseCourseLine(text(seg.substr(gt0 + 1, fe0 - gt0 - 1)), c);

        // 老師：class="blue2" 的連結（可能多位）
        size_t t = 0;
        while ((t = seg.find("class=\"blue2\"", t)) != string::npos) {
            size_t gt = seg.find('>', t);
            size_t close = seg.find("</a>", gt);
            if (gt == string::npos || close == string::npos) break;
            string n = text(seg.substr(gt + 1, close - gt - 1));
            if (!n.empty()) c.teacher += (c.teacher.empty() ? "" : "、") + n;
            t = close;
        }

        // 教室：課名之後的 <font style="…">…</font>，第一個非空且不是「（50人）」的內容
        size_t f = fe0;
        while ((f = seg.find("<font", f)) != string::npos) {
            size_t gt = seg.find('>', f);
            size_t close = seg.find("</font>", gt);
            if (gt == string::npos || close == string::npos) break;
            string n = text(seg.substr(gt + 1, close - gt - 1));
            f = close;
            if (n.empty() || n.rfind("（", 0) == 0) continue;
            c.room = normalizeRoom(n);
            break;
        }
        if (!c.name.empty()) out.push_back(std::move(c));
    }
    return out;
}

static ScheduleResult parseSchedule(const string& rawHtml) {
    const string html = stripBlocks(rawHtml);
    ScheduleResult res;

    // 學期："115 學年第1學期"
    size_t p = html.find("學年第");
    if (p != string::npos) {
        size_t a = p;
        while (a > 0 && (html[a - 1] == ' ' || std::isdigit(static_cast<unsigned char>(html[a - 1])))) --a;
        string year = collapse(html.substr(a, p - a));
        char term = html[p + string("學年第").size()];
        if (!year.empty() && std::isdigit(static_cast<unsigned char>(term))) res.semester = year + "-" + term;
    }

    size_t pos = 0;
    while ((pos = html.find("<tr", pos)) != string::npos) {
        size_t end = html.find("</tr>", pos);
        if (end == string::npos) break;
        string row = html.substr(pos, end - pos);
        pos = end + 5;

        auto cells = cellsOf(row);
        if (cells.size() < 9) continue;
        string pn = text(cells[0]);
        if (pn.empty() || !std::all_of(pn.begin(), pn.end(), [](unsigned char c) { return std::isdigit(c) != 0; })) continue;
        int period = std::stoi(pn);

        auto times = splitWords(text(cells[1]));  // "08:10" "09:00"
        if (times.size() < 2 || times[0].find(':') == string::npos) continue;

        for (size_t idx = 2; idx <= 8; ++idx) {
            int weekday = static_cast<int>((idx - 1) % 7);  // idx2=一(1) … idx7=六(6), idx8=日(0)
            for (auto& c : parseCell(cells[idx])) {
                // 與前一節同一堂課且節次相連 → 合併成一個時段
                bool merged = false;
                for (auto it = res.blocks.rbegin(); it != res.blocks.rend(); ++it) {
                    if (it->weekday == weekday && it->code == c.code && it->name == c.name &&
                        it->room == c.room && it->lastPeriod == period - 1) {
                        it->end = times[1];
                        it->lastPeriod = period;
                        merged = true;
                        break;
                    }
                }
                if (merged) continue;
                Block b;
                b.weekday = weekday; b.start = times[0]; b.end = times[1]; b.lastPeriod = period;
                b.kind = c.kind; b.dept = c.dept; b.code = c.code; b.name = c.name;
                b.section = c.section; b.teacher = c.teacher; b.room = c.room; b.ccode = c.ccode;
                res.blocks.push_back(std::move(b));
            }
        }
    }

    std::stable_sort(res.blocks.begin(), res.blocks.end(), [](const Block& a, const Block& b) {
        int wa = a.weekday == 0 ? 7 : a.weekday, wb = b.weekday == 0 ? 7 : b.weekday;
        return wa != wb ? wa < wb : a.start < b.start;
    });
    return res;
}

static string blockJson(const Block& b, const string& semester, const string& idPrefix = "") {
    std::ostringstream o;
    o << "{";
    if (!idPrefix.empty()) o << "\"id\":" << jstr(idPrefix + b.code + "-" + std::to_string(b.weekday) + "-" + b.start) << ",";
    o << "\"semester\":" << jstr(semester) << ",\"weekday\":" << b.weekday
      << ",\"start\":" << jstr(b.start) << ",\"end\":" << jstr(b.end)
      << ",\"course\":" << jstr(b.name) << ",\"code\":" << jstr(b.code)
      << ",\"room\":" << jstr(b.room) << ",\"teacher\":" << jstr(b.teacher)
      << ",\"kind\":" << jstr(b.kind) << ",\"ccode\":" << jstr(b.ccode) << "}";
    return o.str();
}

// ============================================================
// 課業輔導系統首頁
// ============================================================

struct DashCourse {
    string ccode, code, name, title;
    int unread[5] = {0, 0, 0, 0, 0};  // 公告、教材、投票、作業、討論
};

struct DashItem {
    string ccode, course, title, date, status;  // date: YYYY-MM-DD
    bool unread = false;
};

struct DashResult {
    string semester;
    vector<DashCourse> courses;
    vector<DashItem> notices, assignments;
};

// "標題 (2026/10/24)" → title="標題"、date="2026-10-24"
static void splitTitleDate(const string& raw, string& title, string& date) {
    string s = text(raw);
    title = s;
    date.clear();
    size_t lp = s.rfind('(');
    if (lp == string::npos || s.back() != ')') return;
    string d = s.substr(lp + 1, s.size() - lp - 2);  // 2026/10/24
    if (d.size() == 10 && d[4] == '/' && d[7] == '/') {
        date = d.substr(0, 4) + "-" + d.substr(5, 2) + "-" + d.substr(8, 2);
        title = collapse(s.substr(0, lp));
    }
}

static string attrAfter(const string& s, const string& key, size_t from = 0) {
    size_t a = s.find(key, from);
    if (a == string::npos) return "";
    a += key.size();
    size_t b = s.find('"', a);
    return b == string::npos ? "" : s.substr(a, b - a);
}

static vector<DashItem> parseList(const string& html, const string& itemMarker, const string& spanMarker, const string& anchorTail) {
    vector<DashItem> items;
    size_t pos = 0;
    while ((pos = html.find(itemMarker, pos)) != string::npos) {
        size_t next = html.find(itemMarker, pos + itemMarker.size());
        size_t stop = html.find("class=\"MessageBlock\"", pos + itemMarker.size());
        size_t end = next;
        if (end == string::npos || (stop != string::npos && stop < end)) end = stop;
        string seg = html.substr(pos, end == string::npos ? string::npos : end - pos);
        pos = pos + itemMarker.size();

        DashItem it;
        it.ccode = attrAfter(seg, "?ccode=");
        size_t cut = it.ccode.find('#');
        if (cut != string::npos) it.ccode = it.ccode.substr(0, cut);
        // ccode 屬性值可能是 "406266#mainpage"，只留數字
        string digits;
        for (char c : it.ccode) if (std::isdigit(static_cast<unsigned char>(c))) digits += c; else break;
        it.ccode = digits;

        string aHtml;
        size_t aEnd = 0;
        if (between(seg, anchorTail, "</a>", 0, aHtml, &aEnd)) {
            size_t gt = aHtml.find('>');
            it.course = text(gt == string::npos ? aHtml : aHtml.substr(gt + 1));
        }
        it.unread = seg.find("class=\"ReadState\"") != string::npos;

        size_t sp = seg.find(spanMarker);
        if (sp != string::npos) {
            size_t gt = seg.find('>', sp);
            size_t close = seg.find("</span>", gt);
            if (gt != string::npos && close != string::npos) {
                string raw = seg.substr(gt + 1, close - gt - 1);
                string title, date;
                splitTitleDate(raw, title, date);
                // 作業：開頭 "[未繳交] "
                if (!title.empty() && title[0] == '[') {
                    size_t rb = title.find(']');
                    if (rb != string::npos) {
                        it.status = title.substr(1, rb - 1);
                        title = collapse(title.substr(rb + 1));
                    }
                }
                it.title = title;
                it.date = date;
            }
        }
        if (!it.title.empty()) items.push_back(std::move(it));
    }
    return items;
}

static DashResult parseDashboard(const string& rawHtml) {
    const string html = stripBlocks(rawHtml);
    DashResult r;
    string sem;
    if (between(html, "id=\"CListTitle\">", "</div>", 0, sem)) r.semester = semesterFromCode(collapse(sem));

    // 課程清單
    const string rowMarker = "<div class=\"CListRow\">";
    size_t pos = 0;
    while ((pos = html.find(rowMarker, pos)) != string::npos) {
        size_t next = html.find(rowMarker, pos + rowMarker.size());
        string seg = html.substr(pos, next == string::npos ? string::npos : next - pos);
        pos = pos + rowMarker.size();
        if (seg.find("ccode=") == string::npos) continue;  // 表頭列

        DashCourse c;
        c.ccode = attrAfter(seg, "ccode=");
        string digits;
        for (char ch : c.ccode) if (std::isdigit(static_cast<unsigned char>(ch))) digits += ch; else break;
        c.ccode = digits;
        c.title = collapse(decodeEntities(attrAfter(seg, "title=\"")));
        // "資工系 2A - 2314 資料結構" → code=2314 name=資料結構
        size_t dash = c.title.find(" - ");
        string right = dash == string::npos ? c.title : c.title.substr(dash + 3);
        auto w = splitWords(right);
        if (!w.empty() && w[0].size() >= 3 && isAsciiAlnum(w[0])) {
            c.code = w[0];
            for (size_t i = 1; i < w.size(); ++i) c.name += (c.name.empty() ? "" : " ") + w[i];
        } else {
            c.name = right;
        }
        // 後面五格計數
        int k = 0;
        size_t q = 0;
        while (k < 5 && (q = seg.find("class=\"CListItem\"", q)) != string::npos) {
            size_t gt = seg.find('>', q);
            size_t close = seg.find("</div>", gt);
            if (gt == string::npos || close == string::npos) break;
            string n = text(seg.substr(gt + 1, close - gt - 1));
            c.unread[k++] = n.empty() ? 0 : std::atoi(n.c_str());
            q = close;
        }
        r.courses.push_back(std::move(c));
    }

    r.notices = parseList(html, "<div class=\"AnnoListItem\"", "id=\"AnnoItemSN", "<a href=\"?ccode=");
    r.assignments = parseList(html, "<div class=\"AssiListItem\"", "id=\"AssiItemSN", "<a href=\"?ccode=");
    return r;
}

// ============================================================
// 輸出
// ============================================================

static string scheduleJson(const ScheduleResult& s) {
    std::ostringstream o;
    o << "{\"semester\":" << jstr(s.semester) << ",\"schedule\":[";
    for (size_t i = 0; i < s.blocks.size(); ++i) o << (i ? "," : "") << blockJson(s.blocks[i], s.semester);
    o << "]}";
    return o.str();
}

static string itemJson(const DashItem& it, bool withUnread) {
    std::ostringstream o;
    o << "{\"ccode\":" << jstr(it.ccode) << ",\"course\":" << jstr(it.course)
      << ",\"title\":" << jstr(it.title) << ",\"date\":" << jstr(it.date);
    if (!it.status.empty()) o << ",\"status\":" << jstr(it.status);
    if (withUnread) o << ",\"unread\":" << (it.unread ? "true" : "false");
    o << "}";
    return o.str();
}

static string dashboardJson(const DashResult& d) {
    std::ostringstream o;
    o << "{\"semester\":" << jstr(d.semester) << ",\"courses\":[";
    for (size_t i = 0; i < d.courses.size(); ++i) {
        const auto& c = d.courses[i];
        o << (i ? "," : "") << "{\"ccode\":" << jstr(c.ccode) << ",\"code\":" << jstr(c.code) << ",\"name\":" << jstr(c.name)
          << ",\"unread\":{\"notice\":" << c.unread[0] << ",\"material\":" << c.unread[1] << ",\"poll\":" << c.unread[2]
          << ",\"homework\":" << c.unread[3] << ",\"forum\":" << c.unread[4] << "}}";
    }
    o << "],\"notices\":[";
    for (size_t i = 0; i < d.notices.size(); ++i) o << (i ? "," : "") << itemJson(d.notices[i], true);
    o << "],\"assignments\":[";
    for (size_t i = 0; i < d.assignments.size(); ++i) o << (i ? "," : "") << itemJson(d.assignments[i], false);
    o << "]}";
    return o.str();
}

// 產生 PWA「匯入資料」可直接使用的 JSON。
// 首頁「最新作業」旁的日期是否為截止日尚未確認，所以這裡不匯入作業，
// 避免產生錯誤的截止提醒（見 README）。
static string importJson(const ScheduleResult& s, const DashResult& d) {
    std::ostringstream o;
    o << "{\"schedule\":[";
    for (size_t i = 0; i < s.blocks.size(); ++i) o << (i ? "," : "") << blockJson(s.blocks[i], s.semester, "s");
    o << "],\"notices\":[";
    string sem = d.semester.empty() ? s.semester : d.semester;
    for (size_t i = 0; i < d.notices.size(); ++i) {
        const auto& n = d.notices[i];
        o << (i ? "," : "") << "{\"id\":" << jstr("n" + n.ccode + "-" + std::to_string(i)) << ",\"semester\":" << jstr(sem)
          << ",\"course\":" << jstr(n.course) << ",\"title\":" << jstr(n.title)
          << ",\"postedDate\":" << jstr(n.date) << ",\"read\":" << (n.unread ? "false" : "true") << "}";
    }
    o << "],\"tasks\":[]}";
    return o.str();
}

// ============================================================
// 作業頁（由爬蟲取得的「作業列」文字）
// ============================================================
//
// 爬蟲在瀏覽器裡把各課程「作業」頁中每一列（表格列、清單項目）的可見文字取出，
// 每列一行：  ccode<TAB>課程名稱<TAB>列文字（欄位之間以 " | " 分隔）
// 這裡負責判斷：作業標題、截止時間、是否已繳交。
//
// 截止時間判斷規則（寧可不提醒，也不要錯誤提醒）：
//   1. 日期前面有「截止 / 期限 / 結束 / 繳交 / Due / Deadline / ~ / 至」→ 截止時間（labelled）
//   2. 一列有兩個以上日期、且沒有標示 → 取最晚的日期當截止（range，App 標示「推測」）
//   3. 只有一個沒標示的日期 → 無法判斷是發布日還是截止日，放進 unresolved，不產生提醒
//   日期只有年月日時，截止時間取當天 23:59；民國年（例如 115/10/30）會轉成西元年。

struct DateHit {
    size_t pos = 0, len = 0;
    int y = 0, mo = 0, d = 0, h = -1, mi = 0;
    string role;  // "due" | "start" | "submit" | ""
};

static bool isDigitAt(const string& s, size_t i) { return i < s.size() && std::isdigit(static_cast<unsigned char>(s[i])); }

static int readInt(const string& s, size_t& i, int maxDigits) {
    int v = 0, n = 0;
    while (n < maxDigits && isDigitAt(s, i)) { v = v * 10 + (s[i] - '0'); ++i; ++n; }
    return n ? v : -1;
}

static bool endsWithAny(const string& window, const vector<string>& words) {
    // window 的結尾（去掉空白與冒號）是否為任一關鍵字
    string w = window;
    while (!w.empty() && (w.back() == ' ' || w.back() == ':' || w.back() == '|' || w.back() == '(' || w.back() == '[')) w.pop_back();
    for (const string& colon : {string("："), string("（"), string("【")})
        while (w.size() >= colon.size() && w.compare(w.size() - colon.size(), colon.size(), colon) == 0) {
            w.erase(w.size() - colon.size());
            while (!w.empty() && w.back() == ' ') w.pop_back();
        }
    auto endsWith = [](const string& a, const string& k) { return a.size() >= k.size() && a.compare(a.size() - k.size(), k.size(), k) == 0; };
    // 「截止日期」「開始時間」→ 去掉「日期 / 時間」再比對
    for (const string& suf : {string("日期"), string("時間")})
        if (endsWith(w, suf)) { w.erase(w.size() - suf.size()); break; }
    for (const auto& k : words)
        if (endsWith(w, k)) return true;
    return false;
}

static vector<DateHit> findDates(const string& t) {
    // 注意：單獨的「繳交（時間/日期）」常指『你繳交的時間』，不是期限，所以不列入
    static const vector<string> dueWords = {"截止", "期限", "結束", "到期", "截止日", "繳交期限", "繳交截止",
                                            "Due", "due", "Deadline", "deadline", "End", "end", "~", "～", "至"};
    static const vector<string> startWords = {"開始", "起", "發布", "公告", "發佈", "建立", "更新", "Start", "start", "Posted"};
    // 「繳交時間 / 上傳時間」是你交作業的時間，既不是期限也不是開始，永遠不拿來當截止
    static const vector<string> submitWords = {"繳交", "上傳", "提交", "交件", "Submitted", "submitted"};
    vector<DateHit> out;
    for (size_t i = 0; i < t.size(); ++i) {
        if (!isDigitAt(t, i) || (i > 0 && isDigitAt(t, i - 1))) continue;
        size_t j = i;
        int y = readInt(t, j, 4);
        size_t ylen = j - i;
        if (ylen < 3 || j >= t.size() || (t[j] != '/' && t[j] != '-' && t[j] != '.')) continue;
        char sep = t[j++];
        int mo = readInt(t, j, 2);
        if (mo < 1 || mo > 12 || j >= t.size() || t[j] != sep) continue;
        ++j;
        int d = readInt(t, j, 2);
        if (d < 1 || d > 31 || isDigitAt(t, j)) continue;
        if (ylen == 3) { if (y < 100 || y > 199) continue; y += 1911; }  // 民國年
        if (y < 2000 || y > 2100) continue;

        DateHit h;
        h.pos = i; h.y = y; h.mo = mo; h.d = d;
        // 可選的時間：空白、「上午 / 下午 / AM / PM」、HH:MM(:SS)
        size_t k = j;
        while (k < t.size() && t[k] == ' ') ++k;
        bool pm = false, am = false;
        for (const auto& [word, isPm] : vector<std::pair<string, bool>>{{"下午", true}, {"上午", false}, {"晚上", true}, {"中午", true}}) {
            if (t.compare(k, word.size(), word) == 0) { k += word.size(); (isPm ? pm : am) = true; while (k < t.size() && t[k] == ' ') ++k; break; }
        }
        size_t k2 = k;
        int hh = readInt(t, k2, 2);
        if (hh >= 0 && k2 < t.size() && t[k2] == ':') {
            ++k2;
            int mm = readInt(t, k2, 2);
            if (mm >= 0 && mm < 60 && hh < 24) {
                if (k2 < t.size() && t[k2] == ':') { ++k2; readInt(t, k2, 2); }
                size_t k3 = k2;
                while (k3 < t.size() && t[k3] == ' ') ++k3;
                if (t.compare(k3, 2, "PM") == 0 || t.compare(k3, 2, "pm") == 0) { pm = true; k2 = k3 + 2; }
                else if (t.compare(k3, 2, "AM") == 0 || t.compare(k3, 2, "am") == 0) { am = true; k2 = k3 + 2; }
                if (pm && hh < 12) hh += 12;
                if (am && hh == 12) hh = 0;
                h.h = hh; h.mi = mm; j = k2;
            }
        }
        h.len = j - i;
        size_t from = i >= 30 ? i - 30 : 0;
        string before = t.substr(from, i - from);
        if (endsWithAny(before, dueWords)) h.role = "due";
        else if (endsWithAny(before, startWords)) h.role = "start";
        else if (endsWithAny(before, submitWords)) h.role = "submit";
        out.push_back(h);
        i = j - 1;
    }
    return out;
}

static string fmtDue(const DateHit& h) {
    char b[40];
    std::snprintf(b, sizeof b, "%04d-%02d-%02dT%02d:%02d", h.y, h.mo, h.d, h.h < 0 ? 23 : h.h, h.h < 0 ? 59 : h.mi);
    return b;
}

static bool laterThan(const DateHit& a, const DateHit& b) {
    auto key = [](const DateHit& x) { return ((x.y * 100 + x.mo) * 100 + x.d) * 10000 + (x.h < 0 ? 2359 : x.h * 100 + x.mi); };
    return key(a) > key(b);
}

static string fnv1a(const string& s) {
    uint32_t h = 2166136261u;
    for (unsigned char c : s) { h ^= c; h *= 16777619u; }
    char b[12];
    std::snprintf(b, sizeof b, "%08x", h);
    return b;
}

static vector<string> splitBy(const string& s, const string& sep) {
    vector<string> out;
    size_t a = 0, b;
    while ((b = s.find(sep, a)) != string::npos) { out.push_back(s.substr(a, b - a)); a = b + sep.size(); }
    out.push_back(s.substr(a));
    return out;
}

static bool containsAny(const string& s, const vector<string>& words) {
    for (const auto& w : words) if (s.find(w) != string::npos) return true;
    return false;
}

struct HwTask {
    string id, ccode, course, title, due, confidence;
    bool done = false;
};
struct HwUnresolved { string ccode, course, text, reason; };

static void parseHomeworkRows(const string& input, vector<HwTask>& tasks, vector<HwUnresolved>& unresolved) {
    // 「已閱讀」：文大課輔系統中代表老師已檢視你繳交的作業（首頁的待繳數不含這些作業），視為已完成
    static const vector<string> doneWords = {"已繳交", "已上傳", "已完成", "已交", "已提交", "已閱讀", "Submitted", "submitted"};
    static const vector<string> notDoneWords = {"未繳交", "未上傳", "未完成", "未交", "尚未繳交"};
    static const vector<string> headerWords = {"作業名稱", "標題", "繳交期限", "截止日期", "狀態"};
    static const vector<string> labelOnly = {"截止", "期限", "結束", "開始", "繳交", "狀態", "已繳交", "未繳交", "下載", "上傳", "檢視", "詳細", "批改", "成績"};

    std::istringstream in(input);
    string line;
    std::set<string> seen;
    while (std::getline(in, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        auto cols = splitBy(line, "\t");
        if (cols.size() < 3) continue;
        string ccode = collapse(cols[0]), course = collapse(cols[1]), text = collapse(cols[2]);
        if (text.empty()) continue;
        auto dates = findDates(text);
        if (dates.empty()) continue;
        // 表頭列：含欄名、且日期都是空的（通常不會有日期，保險起見）
        int headerHits = 0;
        for (const auto& w : headerWords) if (text.find(w) != string::npos) ++headerHits;
        if (headerHits >= 3 && dates.empty()) continue;

        // 標題：第一個「不含日期、不是純標籤、不是純數字」的欄位
        string title;
        for (const auto& seg0 : splitBy(text, " | ")) {
            string seg = collapse(seg0);
            if (seg.empty() || !findDates(seg).empty()) continue;
            if (std::all_of(seg.begin(), seg.end(), [](unsigned char c) { return std::isdigit(c) || c == ' ' || c == '.' || c == '/' || c == '%'; })) continue;
            bool isLabel = false;
            for (const auto* list : {&labelOnly, &doneWords, &notDoneWords})  // 狀態欄（未繳交、已閱讀…）不是標題
                for (const auto& w : *list) if (seg == w || seg == "[" + w + "]") isLabel = true;
            if (isLabel) continue;
            title = seg;
            break;
        }
        if (title.empty()) {
            // 整列只有一個欄位（例如「第3週練習 - 2026/10/20」）：取第一個日期前面的文字
            string head = collapse(text.substr(0, dates[0].pos));
            while (!head.empty() && (head.back() == '-' || head.back() == '|' || head.back() == ':' || head.back() == '(')) head = collapse(head.substr(0, head.size() - 1));
            for (bool changed = true; changed;) {  // 反覆去掉結尾的「截止：」「期限（」等標籤
                changed = false;
                for (const string& tail : {string("繳交期限"), string("截止"), string("期限"), string("："), string("（"), string(":")})
                    if (head.size() >= tail.size() && head.compare(head.size() - tail.size(), tail.size(), tail) == 0) {
                        head = collapse(head.substr(0, head.size() - tail.size()));
                        changed = true;
                    }
            }
            title = head;
        }
        if (!title.empty() && title[0] == '[') {  // "[未繳交] 作業一"
            size_t rb = title.find(']');
            if (rb != string::npos && rb + 1 < title.size()) title = collapse(title.substr(rb + 1));
        }
        if (title.empty()) { unresolved.push_back({ccode, course, text, "找不到作業標題"}); continue; }

        const DateHit* due = nullptr;
        string confidence;
        for (const auto& d : dates) if (d.role == "due" && (!due || laterThan(d, *due))) due = &d;
        if (due) confidence = "labelled";
        else {
            vector<const DateHit*> unlabeled;
            for (const auto& d : dates) if (d.role.empty()) unlabeled.push_back(&d);
            if (dates.size() >= 2 && !unlabeled.empty()) {
                for (auto* d : unlabeled) if (!due || laterThan(*d, *due)) due = d;
                confidence = "range";
            }
        }
        if (!due) {
            bool anyUnlabeled = std::any_of(dates.begin(), dates.end(), [](const DateHit& d) { return d.role.empty(); });
            unresolved.push_back({ccode, course, text, anyUnlabeled ? "只有一個未標示的日期，無法判斷是不是截止時間"
                                                                    : "作業頁沒有列出截止日期（只有發布/更新日期）"});
            continue;
        }

        HwTask t;
        t.ccode = ccode; t.course = course; t.title = title; t.due = fmtDue(*due); t.confidence = confidence;
        t.done = containsAny(text, doneWords) && !containsAny(text, notDoneWords);
        t.id = "hw-" + ccode + "-" + fnv1a(title);
        if (seen.count(t.id)) continue;  // 同一份作業出現在兩個區塊（例如清單 + 詳細）只取一次
        seen.insert(t.id);
        tasks.push_back(std::move(t));
    }
}

static string homeworkJson(const vector<HwTask>& tasks, const vector<HwUnresolved>& un) {
    std::ostringstream o;
    o << "{\"tasks\":[";
    for (size_t i = 0; i < tasks.size(); ++i) {
        const auto& t = tasks[i];
        o << (i ? "," : "") << "{\"id\":" << jstr(t.id) << ",\"ccode\":" << jstr(t.ccode) << ",\"course\":" << jstr(t.course)
          << ",\"title\":" << jstr(t.title) << ",\"due\":" << jstr(t.due) << ",\"dueConfidence\":" << jstr(t.confidence)
          << ",\"done\":" << (t.done ? "true" : "false") << "}";
    }
    o << "],\"unresolved\":[";
    for (size_t i = 0; i < un.size(); ++i)
        o << (i ? "," : "") << "{\"ccode\":" << jstr(un[i].ccode) << ",\"course\":" << jstr(un[i].course)
          << ",\"text\":" << jstr(un[i].text) << ",\"reason\":" << jstr(un[i].reason) << "}";
    o << "]}";
    return o.str();
}

int main(int argc, char** argv) {
    try {
        if (argc >= 3 && string(argv[1]) == "schedule") {
            auto s = parseSchedule(readFile(argv[2]));
            if (s.blocks.empty()) { std::cerr << "找不到課表資料，請確認這是『學生課表查詢』頁面（Elements → outerHTML）。\n"; return 2; }
            std::cout << scheduleJson(s) << "\n";
            return 0;
        }
        if (argc >= 3 && string(argv[1]) == "dashboard") {
            auto d = parseDashboard(readFile(argv[2]));
            if (d.courses.empty()) { std::cerr << "找不到課程清單，請確認這是『課業輔導系統』首頁。\n"; return 2; }
            std::cout << dashboardJson(d) << "\n";
            return 0;
        }
        if (argc >= 4 && string(argv[1]) == "import") {
            auto s = parseSchedule(readFile(argv[2]));
            auto d = parseDashboard(readFile(argv[3]));
            if (s.blocks.empty()) { std::cerr << "課表檔解析不到任何課程。\n"; return 2; }
            std::cout << importJson(s, d) << "\n";
            return 0;
        }
        if (argc >= 3 && string(argv[1]) == "homework") {
            vector<HwTask> tasks;
            vector<HwUnresolved> un;
            parseHomeworkRows(readFile(argv[2]), tasks, un);
            std::cout << homeworkJson(tasks, un) << "\n";
            return 0;
        }
        std::cerr << "用法：\n  pccu_parser schedule  課表.html\n  pccu_parser dashboard 首頁.html\n  pccu_parser import    課表.html 首頁.html\n  pccu_parser homework  作業列.txt\n";
        return 1;
    } catch (const std::exception& e) {
        std::cerr << "錯誤：" << e.what() << "\n";
        return 1;
    }
}
