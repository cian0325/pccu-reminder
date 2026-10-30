"""pccu_parser 的測試：用去識別化的假頁面驗證解析結果。
執行：python3 tests/parser_test.py   （需要 g++）
"""
import json, os, subprocess, sys, tempfile

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp = tempfile.mkdtemp()
exe = os.path.join(tmp, "pccu_parser")
subprocess.run(["g++", "-std=c++17", "-Wall", "-Wextra", "-O2", os.path.join(root, "server-cpp", "pccu_parser.cpp"), "-o", exe], check=True)
fx = lambda n: os.path.join(root, "tests", "fixtures", n)
run = lambda *a: json.loads(subprocess.run([exe, *a], check=True, capture_output=True, text=True).stdout)

fail = 0
def ok(cond, msg):
    global fail
    print(("PASS " if cond else "FAIL ") + msg)
    fail += 0 if cond else 1

s = run("schedule", fx("schedule_sample.html"))
by = {(b["weekday"], b["course"]): b for b in s["schedule"]}
ok(s["semester"] == "115-1", "學期 115-1")
ok(len(s["schedule"]) == 3 + 1, "連續節次合併後共 4 個時段")  # 程式設計、體育、通識(週三)、通識(週五)
a = by[(1, "範例程式設計")]
ok(a["start"] == "09:10" and a["end"] == "12:00", "連續 3 節合併為 09:10–12:00")
ok(a["room"] == "大典館 0101", "教室正規化：大典 0101 → 大典館 0101")
ok(a["code"] == "1001" and a["kind"] == "必" and a["teacher"] == "王小明", "課號、必選修、老師")
ok(a["ccode"] == "900001", "取得課輔系統課程代碼 ccode")
p = by[(2, "範例體育")]
ok(p["room"] == "" and p["start"] == "10:10" and p["end"] == "12:00", "沒有教室的課：教室為空字串")
ok(by[(3, "範例通識")]["start"] == "11:10" and by[(3, "範例通識")]["end"] == "13:00", "通識週三 11:10–13:00")
ok((6, "範例通識") in by and by[(6, "範例通識")]["start"] == "13:10", "同一門課週六分開計算（欄位對應 六=6），且班別 (01) 不混入課名")
ok(not any("範例同學" in json.dumps(b, ensure_ascii=False) or "B0000000" in json.dumps(b) for b in s["schedule"]), "輸出不含學生姓名與學號")

d = run("dashboard", fx("dashboard_sample.html"))
ok(d["semester"] == "115-1" and len(d["courses"]) == 2, "首頁：學期與 2 門課（略過表頭列）")
ok(d["courses"][1]["code"] == "CE01" and d["courses"][1]["name"] == "範例通識", "課名與課號（格式 B：通識 0 (01) - CE01 …）")
ok(d["courses"][0]["unread"]["notice"] == 2 and d["courses"][0]["unread"]["homework"] == 1, "未閱讀筆數")
ok(len(d["notices"]) == 2 and d["notices"][0]["unread"] is True and d["notices"][1]["unread"] is False, "公告：第一則未讀、第二則已讀")
ok(d["notices"][0]["date"] == "2026-10-24" and d["notices"][0]["title"] == "期中考公告", "公告日期與標題分離")
ok(d["notices"][1]["title"] == "報告分組 & 說明", "HTML 實體 &amp; 正確還原")
ok(d["assignments"][0]["status"] == "未繳交" and d["assignments"][0]["title"] == "作業一", "作業：繳交狀態與標題")

imp = run("import", fx("schedule_sample.html"), fx("dashboard_sample.html"))
ok(len(imp["schedule"]) == 4 and len(imp["notices"]) == 2 and imp["tasks"] == [], "匯入檔：課表 4、公告 2、作業 0（作業截止日待確認）")
ok(imp["notices"][0]["read"] is False and imp["notices"][0]["postedDate"] == "2026-10-24", "匯入檔公告含未讀狀態與日期")

# ---- 作業列（爬蟲輸出）→ 截止時間
rows = os.path.join(tmp, "rows.txt")
open(rows, "w", encoding="utf-8").write("\n".join([
    "c1\t課A\t作業一 | 開始日期：2026/10/16 08:00 | 截止日期：2026/10/30 23:59 | 未繳交",
    "c1\t課A\t作業二 | 開始日期：2026/09/20 | 截止日期：2026/09/27 | 已繳交",
    "c2\t課B\t期中報告 繳交期限：115/11/05 下午 01:30",
    "c2\t課B\t期末專題 | 2026/12/01 - 2026/12/20",
    "c2\t課B\t閱讀心得（2026/10/01）",
    "c3\t課C\t作業三 | 發布日期：2026/10/01 | 繳交時間：2026/10/02 10:00",
    "c3\t課C\tHW2 截止：2026/11/03 12:00",
    "c3\t課C\tHW2 截止：2026/11/03 12:00",
    "c3\t課C\t沒有日期的列",
]) + "\n")
h = run("homework", rows)
t = {x["title"]: x for x in h["tasks"]}
u = " ".join(x["text"] for x in h["unresolved"])
ok(t["作業一"]["due"] == "2026-10-30T23:59" and t["作業一"]["dueConfidence"] == "labelled" and not t["作業一"]["done"], "欄名『截止日期』→ 確定的截止時間")
ok(t["作業二"]["due"] == "2026-09-27T23:59" and t["作業二"]["done"], "只有日期沒有時間 → 23:59；『已繳交』→ 完成")
ok(t["期中報告"]["due"] == "2026-11-05T13:30", "民國年 115 → 2026；『下午 01:30』→ 13:30")
ok(t["期末專題"]["due"] == "2026-12-20T23:59" and t["期末專題"]["dueConfidence"] == "range", "沒有標示的日期範圍 → 取較晚日期並標為推測（range）")
ok("閱讀心得" in u and "閱讀心得" not in t, "只有一個未標示日期 → 不產生提醒，列入 unresolved")
ok("作業三" in u and "作業三" not in t, "『繳交時間』是交作業的時間，不會被當成截止")
ok(list(t).count("HW2") == 1 and t["HW2"]["due"] == "2026-11-03T12:00", "標題去掉結尾的『截止：』，重複列只算一次")
ok("沒有日期的列" not in u and len(h["tasks"]) == 5, "沒有日期的列直接略過")
ok(all(x["id"].startswith("hw-") for x in h["tasks"]) and run("homework", rows)["tasks"][0]["id"] == h["tasks"][0]["id"], "作業 id 固定（重複執行相同）")

# ---- 作業內容說明：標題之後的欄位；爬蟲用 U+2028 表示欄位裡的換行
detail_rows = os.path.join(tmp, "detail.txt")
open(detail_rows, "w", encoding="utf-8").write("\n".join([
    "c4\t課D\t未繳交 | 更新日期：2026-09-12 16:10:58 | 截止日期：2026/11/26 | Ex2 | 完成 6-4, 8\u20287-4, 11\u2028\u2028Hint: https://example.invalid/hint",
    "c4\t課D\t已閱讀 | 更新日期：2026-09-29 09:29:46 | 截止日期：2026/10/02 | 第一次作業",
]) + "\n")
d = {x["title"]: x for x in run("homework", detail_rows)["tasks"]}
ok(d["Ex2"]["detail"] == "完成 6-4, 8\n7-4, 11\n\nHint: https://example.invalid/hint", "作業說明保留換行、不含狀態與日期欄")
ok(d["第一次作業"]["detail"] == "" and d["第一次作業"]["done"], "沒有說明的作業 detail 是空字串")

# ---- <script> 內的範本字串不應被當成資料
scripted = os.path.join(tmp, "scripted.html")
open(scripted, "w", encoding="utf-8").write(open(fx("dashboard_sample.html"), encoding="utf-8").read().replace(
    "</body>", '<script>const t = `<div class="CListRow"><a href="?ccode=${x}" title="${y}">`;</script><style>.CListRow{}</style></body>'))
ok(len(run("dashboard", scripted)["courses"]) == 2, "忽略 <script>／<style> 裡和資料同名的 class")

r = subprocess.run([exe, "schedule", fx("dashboard_sample.html")], capture_output=True, text=True)
ok(r.returncode == 2, "拿錯頁面時回報錯誤而不是輸出空資料")

print("\n全部通過" if not fail else f"\n{fail} 項失敗")
sys.exit(1 if fail else 0)
