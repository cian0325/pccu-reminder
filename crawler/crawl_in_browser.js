// 在「已登入」的課業輔導系統首頁（https://icas.pccu.edu.tw/cfp/）裡執行的一次性爬蟲。
// 由 Claude 透過桌面 App 的瀏覽器窗格執行；結果交給 C++ 的 pccu_parser 判斷截止時間。
//
//  * 課程清單、最新公告：讀首頁
//  * 公告內文：點開 #Popup 彈出視窗讀 #popMessage（課輔系統會把公告標成已讀；OPTS.noticeContent=false 可關閉）
//  * 各課作業：用同網站的隱藏 iframe 載入 /cfp/?ccode=<代碼>#homework，讀 .MateTitleBlock 欄名與 .MateBlock 每份作業
//    （不用逐頁切換，整個流程一次執行完；每門課之間間隔 1.5 秒）
//
// 瀏覽器窗格的單次指令最多 45 秒，整個流程約 1 分鐘，所以在背景執行：
//   執行本檔 → 立刻回傳 {started:true}；之後每隔幾秒讀 window.__pccuCrawl 查看
//   { status: "running", step } 或 { status: "done", result } 或 { status: "error", message }。
// result = { loggedIn, semester, courses, notices, rows, report }；rows 每行「代碼<TAB>課名<TAB>欄位 | 欄位…」，直接給 pccu_parser homework。
(() => {
if (window.__pccuCrawl && window.__pccuCrawl.status === "running") return { started: false, reason: "already running" };
window.__pccuCrawl = { status: "running", step: "開始", startedAt: new Date().toISOString() };
const step = (s) => { window.__pccuCrawl.step = s; };
(async (OPTS = { noticeContent: true, delayMs: 1500 }) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const vis = (e) => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
  const clean = (s) => (s || "").replace(/ /g, " ").replace(/[ \t]+/g, " ").trim();
  const one = (s) => clean(s).replace(/\s*\n\s*/g, " ");
  const hasDate = (s) => /\d{3,4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}/.test(s);

  // ---- 登入與學期：未登入時標題是「Login」
  const sem = clean(document.querySelector("#CListTitle")?.innerText);
  if (!/^\d{4}$/.test(sem)) return { loggedIn: false, semester: sem };

  // ---- 課程清單
  const courses = [...document.querySelectorAll(".CListRow")].map((r) => {
    const a = r.querySelector('a[href*="ccode="]');
    if (!a) return null;
    const cc = (a.getAttribute("href").match(/ccode=(\d+)/) || [])[1];
    const t = one(a.getAttribute("title") || a.innerText);
    const right = t.includes(" - ") ? t.split(" - ").slice(1).join(" - ") : t;
    const m = right.match(/^([A-Za-z0-9]{3,})\s+(.*)$/);
    const counts = [...r.querySelectorAll(".CListItem")].map((e) => parseInt(e.innerText, 10) || 0);
    return { cc, code: m ? m[1] : "", name: m ? m[2] : right, pendingHomework: counts[3] || 0 };
  }).filter((c) => c && c.cc);

  // ---- 最新公告與內文
  const closePopup = () => { const b = [...document.querySelectorAll("#msgBtnArea .AnnoBtn, .AnnoBtn")].find(vis); if (b) b.click(); };
  closePopup();
  const notices = [];
  let last = document.querySelector("#popMessage")?.innerText || "";
  for (const el of document.querySelectorAll('[id^="AnnoItemSN"]')) {
    step(`公告 ${notices.length + 1}`);
    const raw = one(el.innerText);
    const m = raw.match(/^(.*)\s*\((\d{4})\/(\d{2})\/(\d{2})\)$/);
    const n = {
      cc: el.getAttribute("cc") || "",
      course: one(el.parentElement?.querySelector('[id^="AnnoClass"] a')?.innerText),
      title: m ? clean(m[1]) : raw,
      date: m ? `${m[2]}-${m[3]}-${m[4]}` : "",
      unread: !!el.parentElement?.querySelector(".ReadState"),
      teacher: "", content: "", links: []
    };
    if (OPTS.noticeContent) {
      el.click();
      for (let k = 0; k < 32; k++) {
        await sleep(250);
        const box = document.querySelector("#popMessage");
        if (box && vis(box) && box.innerText.trim() && box.innerText !== last) {
          await sleep(300);
          const text = box.innerText.trim();
          last = text;
          const t = text.match(/^\s*發佈老師[：:]\s*(.+)$/m);
          n.teacher = t ? t[1].trim() : "";
          n.content = text.replace(/^\s*發佈老師[：:].*\n?/m, "").replace(/^\s*公告內容[：:]\s*\n?/m, "").trim().slice(0, 8000);
          n.links = [...box.querySelectorAll("a[href]")].map((a) => ({ text: clean(a.innerText), href: a.href }))
            .filter((l) => /^https?:/.test(l.href)).slice(0, 20);
          break;
        }
      }
      closePopup();
      await sleep(800);
    }
    notices.push(n);
  }

  // ---- 各課作業（隱藏 iframe，同網站、同一個登入狀態）
  const rows = [];
  const report = [];
  for (const c of courses) {
    step(`作業 ${rows.length} 列｜讀取 ${c.name}`);
    const f = document.createElement("iframe");
    f.style.cssText = "position:absolute;left:-10000px;top:0;width:1200px;height:900px;border:0";
    f.src = `/cfp/?ccode=${c.cc}#homework`;
    document.body.appendChild(f);
    await new Promise((r) => { f.onload = r; setTimeout(r, 15000); });
    let found = null;
    for (let k = 0; k < 40 && !found; k++) {
      await sleep(250);
      const d = f.contentDocument;
      if (!d) break;
      const blocks = [...d.querySelectorAll(".MateBlock")];
      const empty = /暫無任何內容/.test(d.body?.innerText || "");
      if (blocks.length || (empty && k > 4)) found = { d, blocks };
    }
    if (!found) report.push(`${c.name}：作業頁沒有在時間內載入`);
    else {
      const head = [...(found.d.querySelector(".MateTitleBlock")?.children || [])].map((e) => one(e.innerText));
      for (const b of found.blocks) {
        const cells = [...b.children].map((e, i) => {
          const v = one(e.innerText);
          return v && head[i] && head[i] !== v && hasDate(v) ? `${head[i]}：${v}` : v;
        }).filter(Boolean);
        if (cells.length) rows.push(`${c.cc}\t${c.name}\t${cells.join(" | ").replace(/\t/g, " ")}`);
      }
      if (c.pendingHomework && !found.blocks.length) report.push(`${c.name}：首頁顯示有待繳作業，但作業頁是空的`);
    }
    f.remove();
    await sleep(OPTS.delayMs);
  }
  return { loggedIn: true, semester: sem, courses, notices, rows, report };
})().then((result) => { window.__pccuCrawl = { status: "done", result }; },
          (e) => { window.__pccuCrawl = { status: "error", message: String(e && e.message || e) }; });
return { started: true };
})()
