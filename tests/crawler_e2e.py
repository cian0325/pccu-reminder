"""爬蟲端對端測試：對 tests/mock_icas 的模擬課輔系統跑完整流程。
執行：python3 tests/crawler_e2e.py    （需要 g++ 與 Python Playwright）
"""
import contextlib
import functools
import http.server
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

root = Path(__file__).resolve().parent.parent
mock = root / "tests" / "mock_icas"
crawler = root / "crawler" / "pccu_crawler.py"

fail = 0
def ok(cond, msg):
    global fail
    print(("PASS " if cond else "FAIL ") + msg)
    fail += 0 if cond else 1

# ---- 啟動模擬網站
port = (lambda s: (s.bind(("127.0.0.1", 0)), s.getsockname()[1], s.close())[1])(socket.socket())
Handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(mock))
Handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{port}/cfp/"

tmp = Path(tempfile.mkdtemp())
env = {**os.environ, "PCCU_CRAWLER_PROFILE": str(tmp / "profile"), "PCCU_CRAWLER_STATE": str(tmp / "state.json")}
out = tmp / "out" / "my-data.json"
run = lambda *a: subprocess.run([sys.executable, str(crawler), "--base", base, "--delay", "0", "--semester", "115-1", "--out", str(out), *a],
                                env=env, capture_output=True, text=True, timeout=180)

# 1. 沒登入 → 結束代碼 3，提示執行 --login
r = run()
ok(r.returncode == 3 and "--login" in r.stdout, "未登入時停止並提示 --login（代碼 3）；不會被看得見的「Login」標題騙過")
ok(not out.exists(), "未登入時不產生輸出檔")

# 2. 模擬「使用者在 --login 視窗自己登入」：用同一個瀏覽器設定檔登入一次
from playwright.sync_api import sync_playwright
with sync_playwright() as pw:
    ctx = pw.chromium.launch_persistent_context(str(tmp / "profile"), headless=True)
    page = ctx.new_page()
    page.goto(base)
    page.click("#loginBtn")
    page.wait_for_selector("#CListTitle", state="visible")
    # 與爬蟲 --login 成功後相同：把 Cookie（含關閉瀏覽器就失效的工作階段 Cookie）存起來
    (tmp / "state.json").write_text(json.dumps({"cookies": ctx.cookies()}))
    ctx.close()

# 3. 已登入 → 正常爬取
r = run("--dump", str(tmp / "dump"))
print(r.stdout[-600:], r.stderr[-600:])
ok(r.returncode == 0, "登入後爬取成功")
data = json.loads(out.read_text(encoding="utf-8"))
tasks = {t["title"]: t for t in data["tasks"]}

ok("切換到 115-1" in r.stdout, "頁面預設顯示舊學期時，自動切換到 115-1")
ok("舊學期作業" not in tasks and all(t["ccode"] != "800001" for t in data["tasks"]), "不會抓到舊學期課程的作業")
ok(tasks.get("作業一：串列", {}).get("due") == "2026-10-30T23:59" and tasks["作業一：串列"]["dueConfidence"] == "labelled",
   "div 版面作業（.MateBlock）：欄名『截止日期』→ 確定的截止時間；只有日期 → 23:59")
ok(tasks.get("作業二：指標", {}).get("done") is True, "狀態『已閱讀』→ 已完成")
ok(tasks.get("作業一：串列", {}).get("done") is False, "狀態『未繳交』→ 未完成")
ok("第一週實習課表單" not in tasks, "沒有截止日期（只有更新日期）的作業不產生提醒")
ok(tasks.get("期中報告", {}).get("due") == "2026-11-05T12:00", "清單作業：民國年 115/11/05 12:00 → 2026-11-05T12:00")
ok("閱讀心得" not in " ".join(tasks), "只有一個未標示日期的作業不產生提醒")
report = (out.parent / "crawl-report.txt").read_text(encoding="utf-8")
ok("閱讀心得" in report, "無法判斷的作業寫進 crawl-report.txt")
ok("第一週實習課表單" in report and "沒有列出截止日期" in report, "報告說明『作業頁沒有列出截止日期』")
ok("範例體育" in report, "首頁說有作業、作業頁卻沒有日期 → 報告提醒")
ok("系統維護" not in json.dumps(data, ensure_ascii=False) and "首頁上的作業" not in tasks, "作業頁以外的日期（公告列、首頁最新作業）不會被當成作業")
ok(all(t["source"] == "crawler" and t["semester"] == "115-1" and "#homework" in t["url"] for t in data["tasks"]), "作業帶有來源、學期與原始頁面連結")

notices = {n["title"]: n for n in data["notices"]}
n1 = notices.get("期中考公告", {})
ok("第 1～6 章" in (n1.get("content") or "") and "大義館 0408" in n1["content"], "點開公告取得內文")
ok(not (n1.get("content") or "").startswith("期中考公告"), "內文開頭不重複標題")
ok("發佈老師" not in n1["content"] and "公告內容" not in n1["content"] and n1.get("teacher") == "王小明", "去掉『發佈老師／公告內容』標籤，老師另存")
ok(any(l["href"].endswith("range.pdf") for l in n1.get("links", [])), "公告附件連結")
ok(n1.get("read") is False and notices.get("報告分組 & 說明", {}).get("read") is True, "保留未讀／已讀狀態")
ok(notices.get("報告分組 & 說明", {}).get("content") == "分組名單已上傳到教材區。", "第二則公告內文（對話框關閉後可再點下一則）")
ok(len({n["id"] for n in data["notices"]}) == 2, "公告 id 不重複")

# 4. 同樣資料再跑一次：id 不變（App 才能保留你的完成標記）
first_ids = sorted(t["id"] for t in data["tasks"]) + sorted(n["id"] for n in data["notices"])
r2 = run("--no-notice-content")
data2 = json.loads(out.read_text(encoding="utf-8"))
ok(sorted(t["id"] for t in data2["tasks"]) + sorted(n["id"] for n in data2["notices"]) == first_ids, "重複執行時作業與公告 id 相同")
ok(all(not n.get("content") for n in data2["notices"]), "--no-notice-content 不點開公告")
ok(oct(os.stat(tmp / "state.json").st_mode & 0o777) == "0o600", "登入狀態檔只有自己能讀（600）")
ok((tmp / "dump" / "homework-900001.html").exists() and (tmp / "dump" / "homework-rows.txt").exists(), "--dump 存下頁面與作業列")

srv.shutdown()
print("\n全部通過" if not fail else f"\n{fail} 項失敗")
sys.exit(1 if fail else 0)
