"""自動登入爬蟲（crawler/auto_crawl.py）端對端測試：對 tests/mock_icas 的模擬課輔系統執行。
模擬網站只接受虛構的測試帳號 test-student / test-only-pw；帳密直接傳入，不碰系統的認證管理員。
執行：python3 tests/auto_crawl_e2e.py    （需要 Python Playwright）
"""
import argparse
import functools
import http.server
import json
import socket
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root / "crawler"))
import auto_crawl  # noqa: E402

fail = 0
def ok(cond, msg):
    global fail
    print(("PASS " if cond else "FAIL ") + msg)
    fail += 0 if cond else 1

port = (lambda s: (s.bind(("127.0.0.1", 0)), s.getsockname()[1], s.close())[1])(socket.socket())
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass
Handler = functools.partial(Quiet, directory=str(root / "tests" / "mock_icas"))
srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()

tmp = Path(tempfile.mkdtemp())
args = argparse.Namespace(base=f"http://127.0.0.1:{port}/cfp/", data_dir=str(tmp / "data"), semester="1151", headed=False)
log = auto_crawl.Log(tmp / "data")

# 1. 密碼錯誤 → 登入失敗，status.json 說明原因，不產生 crawl.json
code = auto_crawl.run(args, ("test-student", "wrong-password"), log)
status = json.loads((tmp / "data" / "status.json").read_text(encoding="utf-8"))
ok(code == auto_crawl.EXIT_LOGIN_FAILED and status["reason"] == "login_failed" and not status["ok"], "密碼錯誤 → 登入失敗並寫入 status.json")
ok(not (tmp / "data" / "crawl.json").exists(), "登入失敗時不產生 crawl.json")
ok("wrong-password" not in (tmp / "data" / "last-run.log").read_text(encoding="utf-8") + json.dumps(status), "密碼不會出現在紀錄或狀態檔")

# 2. 正確帳密 → 透過登入視窗登入、切到 1151、執行 crawl_in_browser.js
code = auto_crawl.run(args, ("test-student", "test-only-pw"), log)
crawl = json.loads((tmp / "data" / "crawl.json").read_text(encoding="utf-8"))
status = json.loads((tmp / "data" / "status.json").read_text(encoding="utf-8"))
logtext = (tmp / "data" / "last-run.log").read_text(encoding="utf-8")
ok(code == 0 and status["ok"] and crawl["loggedIn"], "自動登入並完成爬取")
ok("test-only-pw" not in logtext + json.dumps(crawl, ensure_ascii=False), "密碼不會出現在紀錄或輸出")
ok(crawl["semester"] == "1151" and "切換學期 1142 → 1151" in logtext, "頁面預設顯示舊學期時切換到目前學期")
ok({c["cc"] for c in crawl["courses"]} == {"900001", "900002", "900003"}, "課程清單只有本學期")
ok(any("作業一：串列" in r and "截止日期：2026/10/30" in r for r in crawl["rows"]), "作業列帶有欄名（交給 C++ 判斷截止時間）")
ok(any(n["title"] == "期中考公告" and "第 1～6 章" in n["content"] for n in crawl["notices"]), "公告內文")
ok(crawl.get("crawledAt") and status["at"] == crawl["crawledAt"], "記錄爬取時間")

# 3. 結果可直接交給 build_sync.py + C++ pccu_parser
exe = tmp / "pccu_parser"
subprocess.run(["g++", "-std=c++17", "-O2", str(root / "server-cpp" / "pccu_parser.cpp"), "-o", str(exe)], check=True)
r = subprocess.run([sys.executable, str(root / "crawler" / "build_sync.py"), str(tmp / "data" / "crawl.json"), "--parser", str(exe)],
                   capture_output=True, text=True, encoding="utf-8")
sync = json.loads(r.stdout)
tasks = {t["title"]: t for t in sync["tasks"]}
ok(tasks.get("作業一：串列", {}).get("due") == "2026-10-30T23:59" and tasks["作業一：串列"]["detail"] == "完成第 3 章習題，繳交期限見上方。",
   "build_sync + C++ 解析出截止時間與作業要求")

# 4. 沒設定帳密 → 提示執行 setup.bat
auto_crawl.load_credentials = lambda: None
sys.argv = ["auto_crawl.py", "--data-dir", str(tmp / "data2")]
try:
    auto_crawl.main()
    code = 0
except SystemExit as e:
    code = e.code
st = json.loads((tmp / "data2" / "status.json").read_text(encoding="utf-8"))
ok(code == auto_crawl.EXIT_NO_CREDS and st["reason"] == "no_credentials" and "setup.bat" in st["message"], "沒設定帳密時提示執行 setup.bat")

srv.shutdown()
print("\n全部通過" if not fail else f"\n{fail} 項失敗")
sys.exit(1 if fail else 0)
