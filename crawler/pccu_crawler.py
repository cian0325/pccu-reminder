#!/usr/bin/env python3
"""課輔提醒爬蟲：在你自己的電腦上，用你登入過的瀏覽器工作階段讀取課業輔導系統，
產生 App 可匯入的 my-data.json（作業截止時間、公告與公告內文）。

  第一次（會開一個瀏覽器視窗，請你自己登入）：
      python3 pccu_crawler.py --login
  之後（不開視窗，可排程每天執行）：
      python3 pccu_crawler.py

設計原則
  * 不保存、不詢問你的帳號密碼。登入狀態存在 ~/.pccu-crawler/profile（和瀏覽器的 Cookie 一樣），
    刪掉這個資料夾就等於登出。
  * 只讀取你自己的課程頁面，每頁之間預設間隔 2 秒，避免對學校系統造成負擔。
  * 「抓取」由這支 Python 程式用瀏覽器完成（因為課輔系統的內容是 JavaScript 載入的）；
    「解析」交給 C++ 的 pccu_parser（與 App 匯入用的是同一套規則）。
  * 判斷不出截止時間的作業不會產生提醒，而是寫進 crawl-report.txt，方便之後調整規則。
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlencode, urljoin

HERE = Path(__file__).resolve().parent
DEFAULT_BASE = "https://icas.pccu.edu.tw/cfp/"
PROFILE_DIR = Path(os.environ.get("PCCU_CRAWLER_PROFILE") or Path.home() / ".pccu-crawler" / "profile")
# 許多學校系統的登入 Cookie 是「關閉瀏覽器就失效」的工作階段 Cookie，瀏覽器設定檔不會保留它們，
# 所以另外把 Cookie 存在這個只有你能讀的檔案，下次執行時放回去。
STATE_FILE = Path(os.environ.get("PCCU_CRAWLER_STATE") or PROFILE_DIR.parent / "state.json")
DEFAULT_OUT = Path.home() / "pccu-reminder-data" / "my-data.json"

EXIT_LOGIN_REQUIRED = 3

# ---------------------------------------------------------------- 學期


def current_semester(today: dt.date | None = None) -> str:
    """與 App、C++ 相同：8 月～隔年 1 月為第 1 學期，2～7 月為第 2 學期。回傳 "115-1"。"""
    d = today or dt.date.today()
    y = d.year - 1911
    if d.month >= 8:
        return f"{y}-1"
    if d.month == 1:
        return f"{y - 1}-1"
    return f"{y - 1}-2"


def semester_code(sem: str) -> str:
    return sem.replace("-", "")  # "115-1" → "1151"


# ---------------------------------------------------------------- C++ 解析器


def find_parser(explicit: str | None) -> Path:
    """找到 pccu_parser 執行檔；找不到就用 g++ 編譯 server-cpp/pccu_parser.cpp。"""
    if explicit:
        p = Path(explicit)
        if not p.exists():
            sys.exit(f"找不到解析器：{p}")
        return p
    exe = HERE.parent / "server-cpp" / ("pccu_parser.exe" if os.name == "nt" else "pccu_parser")
    src = HERE.parent / "server-cpp" / "pccu_parser.cpp"
    if exe.exists() and exe.stat().st_mtime >= src.stat().st_mtime:
        return exe
    gxx = shutil.which("g++") or shutil.which("clang++")
    if not gxx:
        sys.exit("需要 C++ 編譯器（g++ 或 clang++）來編譯 server-cpp/pccu_parser.cpp，或用 --parser 指定已編譯好的執行檔。")
    print(f"編譯 C++ 解析器：{src.name}")
    subprocess.run([gxx, "-std=c++17", "-O2", str(src), "-o", str(exe)], check=True)
    return exe


def run_parser(parser: Path, *args: str) -> dict:
    r = subprocess.run([str(parser), *args], capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        raise RuntimeError(f"pccu_parser {args[0]} 失敗：{r.stderr.strip()}")
    return json.loads(r.stdout)


# ---------------------------------------------------------------- 瀏覽器端的擷取程式

# 把作業頁中「可見的」每一列取出來：表格列（不含巢狀表格的外層列）與清單項目。
# 優先使用 id/class 帶有 homework / assi 的區塊；找不到才退回整個內容區，並排除首頁的「最新」區塊。
JS_HOMEWORK_ROWS = r"""
() => {
  const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const clean = (s) => s.replace(/ /g, " ").replace(/[ \t]+/g, " ").trim();
  const hasDate = (s) => /\d{3,4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}/.test(s);
  const pick = () => {
    const cands = [...document.querySelectorAll('[id*="omework" i], [class*="omework" i], [id*="assi" i], [class*="assi" i], [id*="hw" i]')]
      .filter((e) => vis(e) && !e.closest("#MyNews") && hasDate(e.innerText || ""));
    // 取包含日期、且最「外層」的那個區塊
    const outer = cands.filter((e) => !cands.some((o) => o !== e && o.contains(e)));
    if (outer.length) return outer;
    const fallback = document.querySelector("#MainContainer, #content_wrapper, #container") || document.body;
    return [fallback];
  };
  // 表格的欄名（例如「截止日期」）通常只出現在表頭，這裡把欄名加在每一格前面：
  // 「2026/10/30 23:59」→「截止日期：2026/10/30 23:59」，C++ 才能確定那是截止時間。
  const headersOf = (table) => {
    const th = [...table.querySelectorAll("thead tr, tr")].find((r) => r.querySelector("th") || !hasDate(r.innerText || ""));
    return th ? [...th.children].map((c) => clean(c.innerText || "")) : [];
  };
  const rows = [];
  // 文大課輔系統（實際頁面）：欄名在 .MateTitleBlock（狀態／更新日期／截止日期／作業標題），每份作業是一個 .MateBlock
  const mateHead = [...(document.querySelector(".MateTitleBlock")?.children || [])].map((c) => clean(c.innerText || ""));
  const mates = [...document.querySelectorAll(".MateBlock")].filter((b) => vis(b) && !b.closest("#MyNews"));
  if (mateHead.length && mates.length) {
    for (const b of mates) {
      const cells = [...b.children].map((c, i) => {
        const v = clean(c.innerText || "");
        const h = mateHead[i];
        if (v && h && h !== v && hasDate(v) && v.length < 40) return `${h}：${v}`;
        // 作業說明保留換行：寫成 U+2028，整份作業仍在同一列（pccu_parser 會換回換行）
        return (c.innerText || "").split(/\r?\n/).map(clean).join("\u2028").replace(/^\u2028+|\u2028+$/g, "");
      }).filter(Boolean);
      if (cells.length) rows.push(cells.join(" | "));
    }
    return [...new Set(rows)].filter(hasDate);
  }
  for (const root of pick()) {
    for (const tr of root.querySelectorAll("tr")) {
      if (!vis(tr) || tr.querySelector("tr") || tr.closest("#MyNews")) continue;
      const table = tr.closest("table");
      const heads = table ? headersOf(table) : [];
      const cells = [...tr.children].map((c, i) => {
        const v = clean(c.innerText || "");
        const h = heads[i];
        return v && h && h !== v && hasDate(v) ? `${h}：${v}` : v;
      }).filter(Boolean);
      if (cells.length) rows.push(cells.join(" | "));
    }
    for (const li of root.querySelectorAll("li, .AssiListItem, [class*='Item']")) {
      if (!vis(li) || li.querySelector("tr, li") || li.closest("#MyNews") || li.closest("tr")) continue;
      const t = clean((li.innerText || "").replace(/\s*\n\s*/g, " | "));
      if (t) rows.push(t);
    }
  }
  return [...new Set(rows)].filter(hasDate);
}
"""

JS_FIND_DIALOG = r"""
(title) => {
  const vis = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const sels = ["#popMessage", "#Popup", "#dialog", ".ui-dialog-content", ".ui-dialog", ".k-window-content", ".k-window",
                ".fancybox-inner", ".fancybox-wrap", "[role=dialog]", ".modal.show .modal-body"];
  for (const s of sels) {
    for (const e of document.querySelectorAll(s)) {
      const text = (e.innerText || "").trim();
      if (vis(e) && text.length > 0) {
        const links = [...e.querySelectorAll("a[href]")]
          .map((a) => ({ text: (a.innerText || a.getAttribute("title") || "").trim(), href: a.href }))
          .filter((l) => /^https?:/.test(l.href));
        return { text, links };
      }
    }
  }
  return null;
}
"""

JS_CLOSE_DIALOG = r"""
() => {
  for (const s of ["#msgBtnArea .AnnoBtn", ".AnnoBtn", ".ui-dialog-titlebar-close", ".k-window-action", ".k-i-close", ".fancybox-close", ".modal.show [data-dismiss]", "#dialogClose"]) {
    const b = document.querySelector(s);
    if (b) { b.click(); return true; }
  }
  return false;
}
"""

# ---------------------------------------------------------------- 主要流程


class Crawler:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.base = args.base if args.base.endswith("/") else args.base + "/"
        self.parser = find_parser(args.parser)
        self.tmp = Path(tempfile.mkdtemp(prefix="pccu-crawl-"))
        self.dump = Path(args.dump) if args.dump else None
        self.report: list[str] = []
        self.sem = args.semester or current_semester()

    def log(self, msg: str) -> None:
        print(msg, flush=True)

    def pause(self) -> None:
        time.sleep(self.args.delay)

    def save_dump(self, name: str, text: str) -> None:
        if self.dump:
            self.dump.mkdir(parents=True, exist_ok=True)
            (self.dump / name).write_text(text, encoding="utf-8")

    # ---- 登入

    def restore_cookies(self, ctx) -> None:
        if STATE_FILE.exists():
            try:
                ctx.add_cookies(json.loads(STATE_FILE.read_text(encoding="utf-8")).get("cookies", []))
            except Exception as e:
                self.log(f"（略過損壞的登入狀態檔：{e.__class__.__name__}）")

    def save_cookies(self, ctx) -> None:
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = STATE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps({"cookies": ctx.cookies()}), encoding="utf-8")
        with contextlib.suppress(Exception):
            os.chmod(tmp, 0o600)  # 只有你自己的帳號能讀
        tmp.replace(STATE_FILE)

    def is_logged_in(self, page) -> bool:
        # 實際頁面未登入時也看得到 #CListTitle，內容是「Login」；登入後是學期代碼（例如 1151）。
        # 所以要「看得見、而且內容是 4 位數學期」，或看得見「登出」。
        try:
            t = page.locator("#CListTitle")
            if t.count() and t.first.is_visible() and re.fullmatch(r"\d{4}", (t.first.inner_text() or "").strip()):
                return True
            out = page.locator("#logoutab")
            return bool(out.count() and out.first.is_visible())
        except Exception:
            return False

    def ensure_login(self, page) -> None:
        page.goto(self.base, wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        if self.is_logged_in(page):
            return
        if not self.args.login:
            self.log("登入已過期或尚未登入。請執行：python3 pccu_crawler.py --login")
            sys.exit(EXIT_LOGIN_REQUIRED)
        self.log("請在剛打開的瀏覽器視窗登入課業輔導系統（帳號密碼由你自己輸入，這支程式不會讀取）。")
        self.log("登入後看到「我的課程」清單就會自動繼續；最多等 10 分鐘。")
        deadline = time.time() + 600
        while time.time() < deadline:
            for p in page.context.pages:
                if self.is_logged_in(p):
                    if p is not page:
                        page.goto(self.base, wait_until="domcontentloaded")
                        page.wait_for_timeout(1500)
                    self.log("已登入。")
                    return
            time.sleep(2)
        sys.exit("等待登入逾時。")

    # ---- 學期

    def ensure_semester(self, page) -> None:
        want = semester_code(self.sem)
        shown = (page.locator("#CListTitle").first.inner_text() or "").strip()
        if shown == want:
            return
        sel = page.locator("#CListYYM")
        if sel.count() and want in sel.first.inner_html():
            self.log(f"切換到 {self.sem} 學期（頁面原本顯示 {shown}）")
            sel.first.select_option(want)
            page.wait_for_timeout(2500)
            shown = (page.locator("#CListTitle").first.inner_text() or "").strip()
        if shown != want:
            self.report.append(f"警告：頁面顯示的學期是 {shown}，不是 {want}；只會收錄 {self.sem} 的資料。")

    # ---- 首頁：課程清單、最新公告、公告內文

    def read_dashboard(self, page) -> dict:
        html = page.content()
        self.save_dump("dashboard.html", html)
        f = self.tmp / "dashboard.html"
        f.write_text(html, encoding="utf-8")
        return run_parser(self.parser, "dashboard", str(f))

    def read_notice_contents(self, page, notices: list[dict]) -> None:
        last_text = None
        for i, n in enumerate(notices):
            item = page.locator(f"#AnnoItemSN{i}")
            if not item.count():
                continue
            before_url = page.url
            try:
                item.first.click(timeout=5000)
            except Exception as e:  # 被遮住或不能點
                self.report.append(f"公告「{n['title']}」無法點開：{e.__class__.__name__}")
                continue
            got = None
            for _ in range(24):
                page.wait_for_timeout(250)
                got = page.evaluate(JS_FIND_DIALOG, n["title"])
                if got and got["text"] and got["text"] != last_text:
                    break
            if got and got["text"] == last_text:
                got = None  # 等不到新內容：寧可沒有內文，也不要放上一則的內容
            if got:
                last_text = got["text"]
                text = got["text"]
                m = re.search(r"^\s*發佈老師[：:]\s*(.+)$", text, re.M)
                if m:
                    n["teacher"] = m.group(1).strip()
                text = re.sub(r"^\s*發佈老師[：:].*\n?", "", text, count=1, flags=re.M)
                text = re.sub(r"^\s*公告內容[：:]\s*\n?", "", text, count=1, flags=re.M)
                # 對話框開頭常是「關閉」按鈕與標題本身，去掉這些重複的行
                skip = {n["title"], "最新公告", "公告", "關閉", "Close", "close", "×", "X", "x", "✕"}
                lines = [ln.rstrip() for ln in text.splitlines()]
                while lines and (not lines[0].strip() or lines[0].strip() in skip):
                    lines.pop(0)
                n["content"] = "\n".join(lines).strip()[:8000]
                n["links"] = got["links"][:20]
            else:
                self.report.append(f"公告「{n['title']}」點開後找不到內文區塊（可用 --dump 存下頁面協助調整）。")
            if not page.evaluate(JS_CLOSE_DIALOG):
                page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            if page.url != before_url:
                page.goto(before_url, wait_until="domcontentloaded")
                page.wait_for_timeout(1500)
            self.pause()

    # ---- 各課作業頁

    def read_homework(self, page, courses: list[dict]) -> str:
        lines = []
        for c in courses:
            cc = c["ccode"]
            url = urljoin(self.base, "?" + urlencode({"ccode": cc})) + "#homework"
            self.log(f"讀取作業：{c['name']}")
            page.goto(url, wait_until="domcontentloaded")
            try:
                page.wait_for_load_state("networkidle", timeout=10000)
            except Exception:
                pass
            page.wait_for_timeout(1500)
            if not self.is_logged_in(page) and page.locator("input[type=password]").count():
                self.log("讀取中途登入過期，請重新執行 --login")
                sys.exit(EXIT_LOGIN_REQUIRED)
            self.save_dump(f"homework-{cc}.html", page.content())
            rows = page.evaluate(JS_HOMEWORK_ROWS)
            for r in rows:
                lines.append(f"{cc}\t{c['name']}\t{r.replace(chr(9), ' ')}")
            if c.get("unread", {}).get("homework", 0) and not rows:
                self.report.append(f"「{c['name']}」首頁顯示有作業，但作業頁沒有找到任何帶日期的列。")
            self.pause()
        text = "\n".join(lines) + "\n"
        self.save_dump("homework-rows.txt", text)
        return text

    # ---- 主程式

    def run(self) -> dict:
        from playwright.sync_api import sync_playwright

        PROFILE_DIR.mkdir(parents=True, exist_ok=True)
        with sync_playwright() as pw:
            ctx = pw.chromium.launch_persistent_context(
                str(PROFILE_DIR), headless=not (self.args.login or self.args.headed), locale="zh-TW",
                viewport={"width": 1280, "height": 900},
            )
            self.restore_cookies(ctx)
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.on("dialog", lambda d: d.dismiss())  # 不讓 alert 卡住
            try:
                self.ensure_login(page)
                self.save_cookies(ctx)
                self.ensure_semester(page)
                dash = self.read_dashboard(page)
                if dash.get("semester") and dash["semester"] != self.sem:
                    self.report.append(f"首頁學期為 {dash['semester']}，與目前學期 {self.sem} 不同。")
                notices = dash.get("notices", [])
                if self.args.notice_content:
                    self.read_notice_contents(page, notices)
                rows_text = self.read_homework(page, dash.get("courses", []))
                self.save_cookies(ctx)  # 伺服器可能在過程中更新了 Cookie
            finally:
                ctx.close()

        rows_file = self.tmp / "homework-rows.txt"
        rows_file.write_text(rows_text, encoding="utf-8")
        hw = run_parser(self.parser, "homework", str(rows_file))
        for u in hw.get("unresolved", []):
            self.report.append(f"無法判斷截止時間（{u['course']}）：{u['text']}　→ {u['reason']}")

        out = {
            "source": "crawler",
            "generatedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            "semester": self.sem,
            "notices": [
                {
                    "id": f"n{n['ccode']}-{n['date']}-{_stable(n['title'])}",
                    "semester": self.sem, "course": n["course"], "ccode": n["ccode"], "title": n["title"],
                    "postedDate": n["date"], "read": not n.get("unread", False),
                    "content": n.get("content"), "links": n.get("links", []), "teacher": n.get("teacher", ""),
                    "url": urljoin(self.base, "?" + urlencode({"ccode": n["ccode"]})) + "#mainpage",
                }
                for n in notices
            ],
            "tasks": [
                {
                    **t, "semester": self.sem, "source": "crawler",
                    "url": urljoin(self.base, "?" + urlencode({"ccode": t["ccode"]})) + "#homework",
                }
                for t in hw.get("tasks", [])
            ],
            "report": self.report,
        }
        return out


def _stable(s: str) -> str:
    """跨次執行都相同的短雜湊（Python 內建 hash() 每次執行都不同，不能用）。"""
    h = 2166136261
    for b in s.encode("utf-8"):
        h = ((h ^ b) * 16777619) & 0xFFFFFFFF
    return f"{h:08x}"


def main() -> None:
    ap = argparse.ArgumentParser(description="課輔提醒爬蟲：產生 App 可匯入的 my-data.json")
    ap.add_argument("--login", action="store_true", help="開啟瀏覽器視窗讓你登入（第一次或登入過期時）")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help=f"輸出檔（預設 {DEFAULT_OUT}）")
    ap.add_argument("--base", default=DEFAULT_BASE, help=argparse.SUPPRESS)
    ap.add_argument("--parser", help="pccu_parser 執行檔路徑（預設自動編譯 server-cpp/pccu_parser.cpp）")
    ap.add_argument("--semester", help="指定學期，例如 115-1（預設依今天日期）")
    ap.add_argument("--delay", type=float, default=2.0, help="每頁之間等待秒數（預設 2）")
    ap.add_argument("--no-notice-content", dest="notice_content", action="store_false",
                    help="不點開公告取內文（點開會讓課輔系統把該公告標成已讀）")
    ap.add_argument("--headed", action="store_true", help="顯示瀏覽器視窗（除錯用）")
    ap.add_argument("--dump", metavar="DIR", help="把讀到的頁面存到 DIR，協助調整解析規則（內含個人資料，勿公開）")
    args = ap.parse_args()

    try:
        import playwright  # noqa: F401
    except ImportError:
        sys.exit("需要先安裝 Playwright：\n  pip install playwright\n  python3 -m playwright install chromium")

    out = Crawler(args).run()
    path = Path(args.out).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)  # 寫完才取代，避免 App 讀到寫一半的檔案

    report = path.with_name("crawl-report.txt")
    report.write_text(
        f"產生時間：{out['generatedAt']}\n學期：{out['semester']}\n"
        f"作業 {len(out['tasks'])} 份、公告 {len(out['notices'])} 則"
        f"（有內文 {sum(1 for n in out['notices'] if n.get('content'))} 則）\n\n" + "\n".join(out["report"] or ["沒有警告。"]) + "\n",
        encoding="utf-8",
    )
    print(f"\n完成：作業 {len(out['tasks'])} 份、公告 {len(out['notices'])} 則 → {path}")
    if out["report"]:
        print(f"有 {len(out['report'])} 則需要注意的訊息，見 {report}")


if __name__ == "__main__":
    main()
