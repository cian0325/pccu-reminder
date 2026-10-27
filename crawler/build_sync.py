#!/usr/bin/env python3
"""把 crawl_in_browser.js 的結果轉成 App 的同步資料（與 pccu_crawler.py 輸出相同格式）。

  python3 build_sync.py crawl.json --parser ./pccu_parser [--previous previous.json] [--schedule my-data.json] > sync.json

  crawl.json     window.__pccuCrawl.result（課程、公告、作業列）
  --previous     上一次的同步資料：保留課表，並讓上次還沒讀的公告維持「未讀」
                 （爬蟲點開公告時，課輔系統會把它標成已讀）
  --schedule     另外指定課表來源（pccu_parser import 的輸出）
截止時間由 C++ 的 pccu_parser homework 判斷，這支程式只負責組合資料。
"""
import argparse
import datetime as dt
import json
import subprocess
import sys
import tempfile
from pathlib import Path

BASE = "https://icas.pccu.edu.tw/cfp/"


def stable(s: str) -> str:
    """與 pccu_crawler.py 相同的短雜湊，讓公告 id 每次都一樣。"""
    h = 2166136261
    for b in s.encode("utf-8"):
        h = ((h ^ b) * 16777619) & 0xFFFFFFFF
    return f"{h:08x}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("crawl")
    ap.add_argument("--parser", required=True)
    ap.add_argument("--previous")
    ap.add_argument("--schedule")
    a = ap.parse_args()

    crawl = json.loads(Path(a.crawl).read_text(encoding="utf-8"))
    if not crawl.get("loggedIn", True):
        sys.exit("爬蟲結果顯示尚未登入課輔系統")
    code = str(crawl["semester"])
    sem = f"{code[:-1]}-{code[-1]}"          # "1151" → "115-1"

    prev = json.loads(Path(a.previous).read_text(encoding="utf-8")) if a.previous else {}
    sched_src = json.loads(Path(a.schedule).read_text(encoding="utf-8")) if a.schedule else prev
    schedule = [s for s in sched_src.get("schedule", []) if s.get("semester") == sem]
    prev_unread = {n["id"] for n in prev.get("notices", []) if not n.get("read")}

    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as f:
        f.write("\n".join(crawl.get("rows", [])) + "\n")
        rows_file = f.name
    r = subprocess.run([a.parser, "homework", rows_file], capture_output=True, text=True, encoding="utf-8")
    if r.returncode != 0:
        sys.exit("pccu_parser homework 失敗：" + r.stderr)
    hw = json.loads(r.stdout)

    notices = []
    for n in crawl.get("notices", []):
        nid = f"n{n['cc']}-{n['date']}-{stable(n['title'])}"
        notices.append({
            "id": nid, "semester": sem, "course": n["course"], "ccode": n["cc"], "title": n["title"],
            "postedDate": n["date"], "read": not n.get("unread") and nid not in prev_unread,
            "content": n.get("content", ""), "links": n.get("links", []), "teacher": n.get("teacher", ""),
            "url": f"{BASE}?ccode={n['cc']}#mainpage",
        })
    tasks = [{**t, "semester": sem, "source": "crawler", "url": f"{BASE}?ccode={t['ccode']}#homework"} for t in hw["tasks"]]

    report = list(crawl.get("report", []))
    for u in hw.get("unresolved", []):
        parts = u["text"].split(" | ")
        title = next((p for p in parts if p and not any(k in p for k in ("日期：", "未繳交", "已閱讀", "已繳交"))), u["text"])
        report.append(f"{u['reason']}（{u['course']}）：{title}")

    out = {
        "source": "crawler",
        "generatedAt": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "semester": sem, "schedule": schedule, "notices": notices, "tasks": tasks, "report": report,
    }
    json.dump(out, sys.stdout, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
