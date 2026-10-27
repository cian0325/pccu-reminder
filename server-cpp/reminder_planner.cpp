// reminder_planner.cpp
// 提醒排程核心：給定作業、課表與「提前多久提醒」的設定，
// 計算接下來需要送出的提醒清單（依時間排序）。
// 純標準函式庫（C++17），不依賴任何第三方套件，方便單元測試與書審說明。
//
// 編譯：g++ -std=c++17 -Wall -Wextra -O2 reminder_planner.cpp -o reminder_planner
// 執行：./reminder_planner

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <ctime>
#include <iostream>
#include <set>
#include <string>
#include <vector>

using Clock = std::chrono::system_clock;
using TimePoint = Clock::time_point;
using Minutes = std::chrono::minutes;

struct Assignment {
    std::string id;
    std::string course;
    std::string title;
    TimePoint due;
    bool done = false;
    std::string semester;  // 例如 "115-1"；空字串視為目前學期
    bool starred = false;  // 使用者標記為重要
    int progressPct = 0;   // 開發進度 0–100（對應前端的階段條）
};

struct ClassSlot {
    int weekday;          // 0=週日 … 6=週六（同 tm_wday）
    int startHour, startMin;
    std::string course;
    std::string room;
    std::string semester;  // 例如 "115-1"；空字串視為目前學期
};

enum class ReminderKind { AssignmentDue, ClassStart };

struct Reminder {
    ReminderKind kind;
    TimePoint fireAt;     // 應該送出提醒的時間
    std::string key;      // 去重用的唯一鍵，避免同一則提醒重複推播
    std::string title;
    std::string body;
};

struct Settings {
    std::vector<int> assignmentLeadMinutes{1440, 180};  // 截止前 1 天、3 小時
    int classLeadMinutes = 30;                           // 上課前 30 分鐘
    // 學校行事曆（對應 pwa/calendar.js）：停課日與學期上課期間，日期格式 "YYYY-MM-DD"
    std::set<std::string> noClassDates;                  // 放假、補假、全校休假
    std::string termStart, termEnd;                      // 空字串代表不限制
};

static std::string formatTime(TimePoint tp) {
    std::time_t t = Clock::to_time_t(tp);
    std::tm tm{};
    localtime_r(&t, &tm);
    char buf[32];
    std::strftime(buf, sizeof buf, "%m/%d %H:%M", &tm);
    return buf;
}

// 作業提醒：每個尚未完成、且提醒時間仍在未來的 lead 各產生一則
std::vector<Reminder> planAssignmentReminders(const std::vector<Assignment>& list,
                                              const Settings& s, TimePoint now) {
    std::vector<Reminder> out;
    for (const auto& a : list) {
        if (a.done) continue;
        if (a.due <= now) continue;  // 已逾期不再提醒

        // 已錯過的提醒只補送「最接近截止」的那一則，避免一次湧入多則
        int catchUpLead = -1;
        for (int lead : s.assignmentLeadMinutes)
            if (a.due - Minutes(lead) < now && (catchUpLead < 0 || lead < catchUpLead)) catchUpLead = lead;

        for (int lead : s.assignmentLeadMinutes) {
            TimePoint fire = a.due - Minutes(lead);
            if (fire < now && lead != catchUpLead) continue;
            Reminder r;
            r.kind = ReminderKind::AssignmentDue;
            r.fireAt = fire < now ? now : fire;
            r.key = "task-" + a.id + "-" + std::to_string(lead);
            r.title = "作業截止提醒";
            r.body = a.course + "：" + a.title + "（截止 " + formatTime(a.due) + "）";
            out.push_back(std::move(r));
        }
    }
    return out;
}

// 計算某堂課在「now 之後」最近一次的開始時間
static std::string ymd(const std::tm& tm) {
    char buf[40];
    std::snprintf(buf, sizeof buf, "%04d-%02d-%02d", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday);
    return buf;
}

// 這天有上課嗎？停課日、學期上課期間以外（寒暑假）都不上課
static bool isClassDay(const std::string& day, const Settings& s) {
    if (s.noClassDates.count(day)) return false;
    if (!s.termStart.empty() && day < s.termStart) return false;  // "YYYY-MM-DD" 可直接用字串比較
    if (!s.termEnd.empty() && day > s.termEnd) return false;
    return true;
}

// 計算某堂課在 now 之後最近一次「實際有上課」的開始時間；最多往後找 8 週（跨過連假）
TimePoint nextOccurrence(const ClassSlot& c, TimePoint now, const Settings& s = Settings{}) {
    std::time_t t = Clock::to_time_t(now);
    std::tm base{};
    localtime_r(&t, &base);
    for (int d = 0; d < 7 * 8; ++d) {
        std::tm cand = base;
        cand.tm_mday += d;
        cand.tm_hour = c.startHour;
        cand.tm_min = c.startMin;
        cand.tm_sec = 0;
        cand.tm_isdst = -1;
        std::time_t ct = std::mktime(&cand);  // mktime 會正規化日期並更新 tm_wday
        if (cand.tm_wday == c.weekday && Clock::from_time_t(ct) > now && isClassDay(ymd(cand), s))
            return Clock::from_time_t(ct);
    }
    return TimePoint::max();
}

std::vector<Reminder> planClassReminders(const std::vector<ClassSlot>& slots,
                                         const Settings& s, TimePoint now) {
    std::vector<Reminder> out;
    for (const auto& c : slots) {
        TimePoint start = nextOccurrence(c, now, s);
        if (start == TimePoint::max()) continue;
        TimePoint fire = start - Minutes(s.classLeadMinutes);
        Reminder r;
        r.kind = ReminderKind::ClassStart;
        r.fireAt = fire < now ? now : fire;
        r.key = "class-" + c.course + "-" + std::to_string(Clock::to_time_t(start));
        r.title = "快上課了";
        r.body = c.course + "　教室：" + c.room + "（" + formatTime(start) + " 開始）";
        out.push_back(std::move(r));
    }
    return out;
}

// 學期判斷：民國年 = 西元年 - 1911。
// 第 1 學期：8 月～隔年 1 月；第 2 學期：2 月～7 月。例：2026/10 → "115-1"
std::string currentSemester(TimePoint now) {
    std::time_t t = Clock::to_time_t(now);
    std::tm tm{};
    localtime_r(&t, &tm);
    int y = tm.tm_year + 1900 - 1911, m = tm.tm_mon + 1;
    if (m >= 8) return std::to_string(y) + "-1";
    if (m == 1) return std::to_string(y - 1) + "-1";
    return std::to_string(y - 1) + "-2";
}

// 只保留目前學期的資料，舊學期（114-1、114-2…）一律不產生提醒
std::vector<Reminder> planAll(const std::vector<Assignment>& allAssignments,
                              const std::vector<ClassSlot>& allSlots,
                              const Settings& s, TimePoint now) {
    const std::string sem = currentSemester(now);
    std::vector<Assignment> as;
    std::vector<ClassSlot> cs;
    for (const auto& a : allAssignments) if (a.semester.empty() || a.semester == sem) as.push_back(a);
    for (const auto& c : allSlots) if (c.semester.empty() || c.semester == sem) cs.push_back(c);

    auto a = planAssignmentReminders(as, s, now);
    auto c = planClassReminders(cs, s, now);
    a.insert(a.end(), c.begin(), c.end());
    std::sort(a.begin(), a.end(), [](const Reminder& x, const Reminder& y) { return x.fireAt < y.fireAt; });
    return a;
}

// 作業優先度（與 pwa/app.js 的 priorityScore() 相同公式）
// 時間越近分數越高（指數衰減）；進度越高最多扣 30%；重要 +25；上限 125
double priorityScore(const Assignment& a, TimePoint now) {
    if (a.done) return -1.0;
    double hoursLeft = std::chrono::duration<double, std::ratio<3600>>(a.due - now).count();
    double score = hoursLeft <= 0 ? 100.0 : 100.0 * std::exp(-hoursLeft / 72.0);
    score *= 1.0 - 0.3 * (a.progressPct / 100.0);
    if (a.starred) score += 25.0;
    return std::min(125.0, score);
}

// 每日總覽：今天的課程數、24 小時內截止的作業數、第一堂課資訊
struct DailyBrief {
    int classesToday = 0;
    int dueWithin24h = 0;
    std::string body;
};

DailyBrief buildDailyBrief(const std::vector<Assignment>& allAssignments,
                           const std::vector<ClassSlot>& allSlots, TimePoint now) {
    const std::string sem = currentSemester(now);
    std::time_t t = Clock::to_time_t(now);
    std::tm tm{};
    localtime_r(&t, &tm);

    DailyBrief b;
    const ClassSlot* first = nullptr;
    for (const auto& c : allSlots) {
        if (!(c.semester.empty() || c.semester == sem) || c.weekday != tm.tm_wday) continue;
        ++b.classesToday;
        if (!first || c.startHour * 60 + c.startMin < first->startHour * 60 + first->startMin) first = &c;
    }
    for (const auto& a : allAssignments) {
        if (a.done || !(a.semester.empty() || a.semester == sem)) continue;
        if (a.due > now && a.due - now <= std::chrono::hours(24)) ++b.dueWithin24h;
    }

    if (first) {
        char hm[16];
        std::snprintf(hm, sizeof hm, "%02d:%02d", first->startHour, first->startMin);
        b.body = "今天 " + std::to_string(b.classesToday) + " 堂課，第一堂 " + hm + " " + first->course +
                 "（" + first->room + "）。";
    } else {
        b.body = "今天沒有課。";
    }
    b.body += b.dueWithin24h ? "24 小時內有 " + std::to_string(b.dueWithin24h) + " 份作業截止。"
                             : "24 小時內沒有作業截止。";
    return b;
}

#ifndef REMINDER_NO_MAIN
static int g_failed = 0;
#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) { std::printf("  FAIL: %s (line %d)\n", #cond, __LINE__); ++g_failed; } \
    } while (0)

static void selfTest() {
    const TimePoint now = Clock::now();
    Settings s;

    // 已完成的作業不應產生提醒
    CHECK(planAssignmentReminders({{"x", "C++", "done", now + Minutes(600), true}}, s, now).empty());

    // 截止在 10 小時後：1 天前的提醒已過、3 小時前的提醒在未來
    auto r = planAssignmentReminders({{"a", "C++", "hw", now + std::chrono::hours(10), false}}, s, now);
    CHECK(r.size() == 2);  // 1 天前的提醒已錯過 → 補送 1 則 + 3 小時前 1 則
    CHECK(r.size() == 2 && r[1].fireAt == now + std::chrono::hours(7));

    // 已逾期的作業不再提醒
    CHECK(planAssignmentReminders({{"b", "C++", "late", now - Minutes(5), false}}, s, now).empty());

    // 下一堂課一定在未來，且提醒時間不早於現在
    std::time_t nowT = Clock::to_time_t(now);
    std::tm nowTm{};
    localtime_r(&nowT, &nowTm);
    auto c = planClassReminders({{(nowTm.tm_wday + 1) % 7, 9, 10, "C++", "B101"}}, s, now);
    CHECK(c.size() == 1);
    CHECK(c.size() == 1 && c[0].fireAt >= now);

    // 行事曆：明天那堂課遇到停課 → 跳到下一週；超過學期上課期間 → 不提醒
    {
        std::tm tm2 = nowTm; tm2.tm_mday += 1; tm2.tm_hour = 12; tm2.tm_isdst = -1; std::mktime(&tm2);
        std::tm tm9 = nowTm; tm9.tm_mday += 9; tm9.tm_hour = 12; tm9.tm_isdst = -1; std::mktime(&tm9);
        Settings hs = s;
        hs.noClassDates.insert(ymd(tm2));
        ClassSlot tomorrowSlot{(nowTm.tm_wday + 1) % 7, 9, 10, "C++", "B101"};
        TimePoint normal = nextOccurrence(tomorrowSlot, now, s);
        TimePoint skipped = nextOccurrence(tomorrowSlot, now, hs);
        CHECK(skipped - normal == std::chrono::hours(24 * 7));
        hs.termEnd = ymd(tm2);  // 學期在「明天」結束，而明天又停課 → 之後都不上課
        CHECK(nextOccurrence(tomorrowSlot, now, hs) == TimePoint::max());
        CHECK(planClassReminders({tomorrowSlot}, hs, now).empty());
        Settings ts = s; ts.termStart = ymd(tm9);  // 學期 9 天後才開始 → 明天與 8 天後那堂都還沒開學
        CHECK(nextOccurrence(tomorrowSlot, now, ts) - normal == std::chrono::hours(24 * 14));
    }

    // 學期過濾：舊學期的作業與課程不應出現在 planAll 的結果
    const std::string sem = currentSemester(now);
    CHECK(sem.size() == 5 && sem[3] == '-');
    auto mixed = planAll({{"cur", "C++", "now", now + std::chrono::hours(10), false, sem},
                          {"old", "Calc", "old", now + std::chrono::hours(10), false, "100-1"}},
                         {{(nowTm.tm_wday + 1) % 7, 9, 10, "Old class", "X", "100-2"}}, s, now);
    for (const auto& r : mixed) CHECK(r.key.find("old") == std::string::npos && r.key.find("Old class") == std::string::npos);
    CHECK(!mixed.empty());

    // 優先度：越接近截止分數越高、重要加分、進度高扣分、已完成為 -1
    Assignment soon{"p1", "C++", "soon", now + std::chrono::hours(5), false, sem};
    Assignment later{"p2", "C++", "later", now + std::chrono::hours(120), false, sem};
    CHECK(priorityScore(soon, now) > priorityScore(later, now));
    Assignment starred = later; starred.starred = true;
    CHECK(priorityScore(starred, now) > priorityScore(later, now));
    Assignment mostlyDone = soon; mostlyDone.progressPct = 90;
    CHECK(priorityScore(mostlyDone, now) < priorityScore(soon, now));
    Assignment finished = soon; finished.done = true;
    CHECK(priorityScore(finished, now) < 0);
    Assignment overdue{"p3", "C++", "late", now - Minutes(30), false, sem};
    CHECK(priorityScore(overdue, now) == 100.0);

    // 每日總覽：今天有一堂課、一份 24 小時內截止的作業
    auto brief = buildDailyBrief({soon, later}, {{nowTm.tm_wday, 9, 10, "C++", "B101", sem}}, now);
    CHECK(brief.classesToday == 1);
    CHECK(brief.dueWithin24h == 1);
}

int main() {
    selfTest();
    if (g_failed) { std::printf("%d test(s) failed\n", g_failed); return 1; }
    std::printf("selftest passed（目前學期 %s）\n\n", currentSemester(Clock::now()).c_str());

    const TimePoint now = Clock::now();
    std::vector<Assignment> as = {
        {"a1", "程式設計（C++）", "作業三：類別與運算子多載", now + std::chrono::hours(5), false},
        {"a2", "資料結構", "實作鏈結串列", now + std::chrono::hours(51), false},
    };
    std::vector<ClassSlot> cs = {
        {1, 9, 10, "程式設計（C++）", "大典館 B101"},
        {2, 13, 10, "資料結構", "大孝館 305"},
    };
    Settings s;
    std::printf("每日總覽：%s\n", buildDailyBrief(as, cs, now).body.c_str());
    std::printf("作業優先度：\n");
    for (const auto& a : as) std::printf("  %-28s %.1f\n", a.title.c_str(), priorityScore(a, now));
    std::printf("\n接下來的提醒（依時間排序）：\n");
    for (const auto& r : planAll(as, cs, s, now))
        std::printf("  [%s] %s｜%s\n    key=%s\n", formatTime(r.fireAt).c_str(), r.title.c_str(), r.body.c_str(), r.key.c_str());
    return 0;
}
#endif
