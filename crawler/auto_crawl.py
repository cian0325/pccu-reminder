#!/usr/bin/env python3
"""課輔提醒：在你自己的 Windows 電腦上每天自動登入課業輔導系統並爬取作業與公告。

  第一次設定（setup.bat 會幫你執行）：
      python auto_crawl.py --setup      # 輸入學號與密碼，存進 Windows 認證管理員
  之後由「工作排程器」每天執行：
      pythonw auto_crawl.py

這支程式負責「登入 + 抓取」，結果寫到 data\\crawl.json；
截止時間的判斷由 C++ 的 pccu_parser 負責（Claude 的每日排程讀這個檔、解析後更新「課輔提醒」）。

安全設計
  * 密碼只存在 Windows 認證管理員（keyring），由 Windows 用你的帳號加密；不寫進任何檔案、不印出、不記錄。
  * 登入由這支程式在你的電腦上完成，Claude 不會看到或輸入你的密碼。
  * 每次執行都用全新的無痕瀏覽器，執行完就關閉，不留下 Cookie。
  * 想停用：在「工作排程器」刪除「PCCU 課輔爬蟲」，並執行 python auto_crawl.py --forget 刪除存好的密碼。
"""

from __future__ import annotations

import argparse
import datetime as dt
import getpass
import json
import re
import sys
import time
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_BASE = "https://icas.pccu.edu.tw/cfp/"
DEFAULT_DATA = HERE / "data"
SERVICE = "pccu-icas-crawler"      # Windows 認證管理員裡的名稱
ACCOUNT_KEY = "__account__"        # 記住「哪個學號」用的項目

EXIT_OK, EXIT_NO_CREDS, EXIT_LOGIN_FAILED, EXIT_CRAWL_FAILED = 0, 2, 3, 4


class LoginFailed(Exception):
    pass


# ---------------------------------------------------------------- 學期（與 App、C++ 相同規則）

def semester_code(today: dt.date | None = None) -> str:
    d = today or dt.date.today()
    y = d.year - 1911
    if d.month >= 8:
        return f"{y}1"
    if d.month == 1:
        return f"{y - 1}1"
    return f"{y - 1}2"


# ---------------------------------------------------------------- 帳密（Windows 認證管理員）

def load_credentials() -> tuple[str, str] | None:
    import keyring
    uid = keyring.get_password(SERVICE, ACCOUNT_KEY)
    pw = keyring.get_password(SERVICE, uid) if uid else None
    return (uid, pw) if uid and pw else None


def save_credentials(uid: str, pw: str) -> None:
    import keyring
    keyring.set_password(SERVICE, uid, pw)
    keyring.set_password(SERVICE, ACCOUNT_KEY, uid)


def forget_credentials() -> None:
    import keyring
    uid = keyring.get_password(SERVICE, ACCOUNT_KEY)
    for key in filter(None, [uid, ACCOUNT_KEY]):
        try:
            keyring.delete_password(SERVICE, key)
        except Exception:
            pass


# ---------------------------------------------------------------- 輸出（寫完才取代，避免讀到寫一半的檔案）

def write_json(path: Path, obj: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


class Log:
    def __init__(self, data: Path):
        self.file = data / "last-run.log"
        data.mkdir(parents=True, exist_ok=True)
        self.file.write_text("", encoding="utf-8")

    def __call__(self, msg: str) -> None:
        line = f"[{dt.datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
        with self.file.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
        print(line, flush=True)   # pythonw 沒有主控台時 print 不會輸出，也不會出錯


# ---------------------------------------------------------------- 瀏覽器操作

def logged_in(page) -> str | None:
    """已登入時回傳學期代碼（例如 1151）。未登入時 #CListTitle 也看得到，內容是「Login」。"""
    try:
        t = (page.locator("#CListTitle").first.inner_text(timeout=2000) or "").strip()
        return t if re.fullmatch(r"\d{4}", t) else None
    except Exception:
        return None


def login(page, base: str, uid: str, pw: str, log: Log) -> str:
    page.goto(base, wait_until="domcontentloaded")
    page.wait_for_timeout(2500)
    if sem := logged_in(page):
        return sem
    log("登入中…")
    link = page.locator('a[onclick*="CallLogin(true)"]')
    if link.count():
        link.first.click()
    else:
        page.evaluate("() => CallLogin(true)")
    page.wait_for_selector("#LoginID", state="visible", timeout=15000)
    page.fill("#LoginID", uid)
    page.fill("#LoginPass", pw)
    got = page.evaluate("() => [document.querySelector('#LoginID').value.length, document.querySelector('#LoginPass').value.length]")
    if got != [len(uid), len(pw)]:   # 欄位有長度限制等情況：只記錄長度，不記錄內容
        log(f"注意：登入欄位內容長度和輸入不同（帳號 {got[0]}/{len(uid)}、密碼 {got[1]}/{len(pw)}）")
    page.click("#SubmitBtn")
    deadline = time.time() + 30
    while time.time() < deadline:
        page.wait_for_timeout(500)
        if sem := logged_in(page):
            return sem
    msg = ""
    try:
        msg = (page.locator("#LoginInner .LoginRow").first.inner_text(timeout=1000) or "").strip()
    except Exception:
        pass
    raise LoginFailed(msg or "登入後沒有看到課程清單")


def ensure_semester(page, want: str, log: Log) -> str:
    shown = logged_in(page) or ""
    if shown == want:
        return shown
    sel = page.locator("#CListYYM")
    if sel.count() and want in sel.first.inner_html():
        log(f"切換學期 {shown} → {want}")
        sel.first.select_option(want)
        for _ in range(30):
            page.wait_for_timeout(500)
            if logged_in(page) == want and page.locator(".CListRow").count():
                break
    return logged_in(page) or shown


def crawl(page, log: Log, timeout_s: int = 300) -> dict:
    """在已登入的首頁執行 crawl_in_browser.js（與 Claude 在瀏覽器窗格用的是同一支），等它完成。"""
    js = (HERE / "crawl_in_browser.js").read_text(encoding="utf-8")
    started = page.evaluate(js)
    if not (isinstance(started, dict) and started.get("started")):
        raise RuntimeError(f"爬蟲沒有啟動：{started}")
    deadline = time.time() + timeout_s
    last_step = ""
    while time.time() < deadline:
        page.wait_for_timeout(2000)
        st = page.evaluate("() => window.__pccuCrawl")
        if st.get("status") == "done":
            return st["result"]
        if st.get("status") == "error":
            raise RuntimeError("爬蟲錯誤：" + str(st.get("message")))
        if st.get("step") != last_step:
            last_step = st.get("step", "")
            log("進度：" + last_step)
    raise RuntimeError("爬蟲逾時")


def run(args: argparse.Namespace, creds: tuple[str, str], log: Log) -> int:
    from playwright.sync_api import sync_playwright

    data = Path(args.data_dir)
    status = data / "status.json"
    now = lambda: dt.datetime.now().astimezone().isoformat(timespec="seconds")
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not args.headed)
        ctx = browser.new_context(locale="zh-TW", viewport={"width": 1280, "height": 900})
        page = ctx.new_page()
        page.on("dialog", lambda d: d.dismiss())   # 學校頁面的 alert 不要卡住流程
        try:
            sem = login(page, args.base, *creds, log)
            log(f"已登入（頁面學期 {sem}）")
            sem = ensure_semester(page, args.semester or semester_code(), log)
            result = crawl(page, log)
        except LoginFailed as e:
            log(f"登入失敗：{e}")
            write_json(status, {"ok": False, "at": now(), "reason": "login_failed",
                                "message": f"登入失敗（{e}）。如果你改過密碼，請重新執行 setup.bat。"})
            return EXIT_LOGIN_FAILED
        except Exception as e:
            log("爬取失敗：" + "".join(traceback.format_exception_only(type(e), e)).strip())
            write_json(status, {"ok": False, "at": now(), "reason": "crawl_failed", "message": str(e)[:300]})
            return EXIT_CRAWL_FAILED
        finally:
            ctx.close()
            browser.close()

    result["crawledAt"] = now()
    write_json(data / "crawl.json", result)
    summary = f"課程 {len(result.get('courses', []))} 門、公告 {len(result.get('notices', []))} 則、作業列 {len(result.get('rows', []))} 列"
    write_json(status, {"ok": True, "at": result["crawledAt"], "semester": result.get("semester"), "message": summary})
    log("完成：" + summary)
    return EXIT_OK


def check_password(pw: str) -> str:
    """找出常見的輸入問題（不顯示密碼本身）。"""
    if not pw:
        return "密碼是空的。"
    if any(ord(c) < 32 or ord(c) == 127 for c in pw):
        return "密碼裡有看不見的控制字元，通常是按了 Ctrl+V。請直接打字，或用滑鼠右鍵貼上。"
    if any(ord(c) > 126 for c in pw):
        return "密碼裡有中文或全形字元，可能是輸入法沒切到英文。請切成英文再輸入。"
    if pw != pw.strip():
        return "密碼前後有空白，請確認是否多打了空白。"
    return ""


def setup(args: argparse.Namespace) -> int:
    print("課輔提醒自動爬蟲設定\n")
    print("學號與密碼會存在 Windows 認證管理員（只有你的 Windows 帳號能讀），不會寫進任何檔案。")
    print("提醒：請先把輸入法切到英文；這個視窗裡 Ctrl+V 不能貼上（貼上請按滑鼠右鍵），建議直接打字。\n")
    uid = input("課輔系統帳號（學號）：").strip()
    while True:
        pw = getpass.getpass("密碼（輸入時畫面不會顯示）：").rstrip("\r\n")
        problem = check_password(pw)
        if problem:
            print(problem + "\n")
            continue
        if getpass.getpass("再輸入一次密碼確認：").rstrip("\r\n") != pw:
            print("兩次輸入的密碼不一樣，請重新輸入。\n")
            continue
        break
    if not uid:
        print("帳號是空的，已取消。")
        return EXIT_NO_CREDS
    print(f"\n帳號：{uid}，密碼長度：{len(pw)} 個字元（可以對照你的密碼長度）")
    save_credentials(uid, pw)
    print("已儲存。現在試跑一次（大約 1～2 分鐘）。會打開一個瀏覽器視窗讓你看登入過程，請不要操作它。\n")
    args.headed = True
    code = run(args, (uid, pw), Log(Path(args.data_dir)))
    if code == EXIT_LOGIN_FAILED:
        print("\n登入失敗。請先到 https://icas.pccu.edu.tw/cfp/ 用同一組帳密手動登入看看；"
              "\n能登入的話，重新執行 setup.bat 時請直接打字輸入（輸入法切英文）。")
    elif code == EXIT_OK:
        print(f"\n成功！結果在 {Path(args.data_dir) / 'crawl.json'}")
    return code


def main() -> None:
    ap = argparse.ArgumentParser(description="課輔提醒：自動登入並爬取課業輔導系統")
    ap.add_argument("--setup", action="store_true", help="輸入並儲存帳號密碼，然後試跑一次")
    ap.add_argument("--forget", action="store_true", help="刪除存在 Windows 認證管理員的帳號密碼")
    ap.add_argument("--data-dir", default=str(DEFAULT_DATA), help=f"輸出資料夾（預設 {DEFAULT_DATA}）")
    ap.add_argument("--semester", help="學期代碼，例如 1151（預設依今天日期）")
    ap.add_argument("--headed", action="store_true", help="顯示瀏覽器視窗（除錯用）")
    ap.add_argument("--base", default=DEFAULT_BASE, help=argparse.SUPPRESS)
    args = ap.parse_args()

    if args.forget:
        forget_credentials()
        print("已刪除存好的帳號密碼。")
        return
    if args.setup:
        sys.exit(setup(args))
    log = Log(Path(args.data_dir))
    creds = load_credentials()
    if not creds:
        log("還沒有設定帳號密碼，請執行 setup.bat")
        write_json(Path(args.data_dir) / "status.json", {
            "ok": False, "at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
            "reason": "no_credentials", "message": "還沒有設定帳號密碼，請執行 setup.bat"})
        sys.exit(EXIT_NO_CREDS)
    sys.exit(run(args, creds, log))


if __name__ == "__main__":
    main()
