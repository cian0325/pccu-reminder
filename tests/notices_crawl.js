// 以最小假 DOM 在 Node 中執行 app.js，驗證互動邏輯
const fs = require("fs"), vm = require("vm"), path = require("path");
const dir = process.argv[2];
const els = new Map();
const mk = () => ({ innerHTML: "", textContent: "", value: "", checked: true, hidden: false, dataset: {}, style: {},
  classList: { toggle() {}, add() {} }, listeners: {}, addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
  scrollIntoView() {}, focus() {} });
const get = (s) => { if (!els.has(s)) els.set(s, mk()); return els.get(s); };
const clickHandlers = [];
const notes = [];
const store = {};
if (process.env.BRIEF_WINDOW) {  // 模擬「已過每日總覽時間 10 分鐘」
  const d = new Date(Date.now() - 10 * 60000);
  store["pccu-reminder-settings"] = JSON.stringify({ briefOn: true, briefTime: String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") });
}
const ctx = {
  console, setInterval() {}, setTimeout, clearTimeout, Date, URLSearchParams, JSON, Math, Object, Set, Map, Number, String, Array, Promise, Error,
  window: { navigator: { standalone: false } }, CSS: { escape: (x) => x },
  localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = v; } },
  navigator: { userAgent: "iPhone", serviceWorker: { register: async () => {}, ready: Promise.resolve({ showNotification: (t, o) => notes.push({ t, ...o }) }) } },
  matchMedia: () => ({ matches: true }), 
  location: { search: "?view=tasks&task=a1" }, Notification: { permission: "granted", requestPermission: async () => "granted" },
  document: { body: { classList: { add() {}, remove() {} } }, querySelector: get, querySelectorAll: () => [], addEventListener: (t, f) => t === "click" && clickHandlers.push(f) },
};
ctx.window.scrollTo = () => {}; ctx.scrollTo = () => {};
ctx.window.Notification = ctx.Notification;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(dir, "data.js"), "utf8"), ctx);
vm.runInContext(fs.readFileSync(path.join(dir, "app.js"), "utf8"), ctx);

const tick = () => new Promise((r) => setTimeout(r, 20));
const click = (id, act, extra = {}) => {
  const li = { dataset: { id } };
  const btn = { dataset: { act, ...extra }, closest: (s) => (s === "[data-id]" ? li : null) };
  const e = { target: { closest: (s) => (s === "[data-act]" ? btn : null) } };
  clickHandlers.forEach((f) => f(e));
};
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };

(async () => {
  await tick();
  let msg = ""; { const t = get("#toast"); Object.defineProperty(t, "textContent", { set(v) { msg = v; this._t = v; }, get() { return this._t || ""; } }); }
  const importText = (obj) => { get("#importText").value = JSON.stringify(obj); get("#btnImport").listeners.click.forEach((f) => f()); };
  const clickOn = (map) => {   // map: selector → 假元素
    const target = { id: map.id || "", closest: (s) => map[s] || null };
    clickHandlers.forEach((f) => f({ target }));
  };
  const H = 3600e3, now = Date.now();
  const iso = (t) => { const d = new Date(t), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

  // 先手動新增一份作業
  importText({ tasks: [{ id: "manual1", semester: "115-1", course: "自己的課", title: "手動作業", due: now + 50 * H }] });
  await tick();

  const crawl1 = {
    source: "crawler", generatedAt: new Date(now - 2 * H).toISOString(), semester: "115-1",
    notices: [
      { id: "nA", semester: "115-1", course: "範例程式設計", title: "期中考公告", postedDate: "2026-10-24", read: false,
        content: "範圍：第 1～6 章\n<img src=x onerror=alert(1)>\n詳情 https://example.invalid/info",
        links: [{ text: "考試範圍.pdf", href: "https://example.invalid/range.pdf" }, { text: "壞連結", href: "javascript:alert(1)" }],
        url: "https://icas.pccu.edu.tw/cfp/?ccode=900001#mainpage" },
      { id: "nB", semester: "115-1", course: "範例通識", title: "沒有內文的公告", postedDate: "2026-10-19", read: true }
    ],
    tasks: [
      { id: "hw-1", semester: "115-1", source: "crawler", course: "範例程式設計", title: "作業一", due: iso(now + 5 * H), dueConfidence: "labelled", done: false, detail: "1. 寫出 operator<<\n2. 上傳 zip https://example.invalid/spec", url: "https://icas.pccu.edu.tw/cfp/?ccode=900001#homework" },
      { id: "hw-2", semester: "115-1", source: "crawler", course: "範例通識", title: "期末專題", due: iso(now + 100 * H), dueConfidence: "range", done: false }
    ],
    report: ["無法判斷截止時間（範例通識）：閱讀心得（2026/10/01）"]
  };
  importText(crawl1); await tick();
  ok(msg.includes("2 份作業") && msg.includes("需要注意"), "匯入爬蟲結果並提示爬蟲訊息：" + msg.split("\n")[0]);
  const tasks = () => get("#tasks").innerHTML;
  ok(tasks().includes("作業一") && tasks().includes("手動作業"), "爬蟲作業與手動作業並存");
  ok(tasks().includes("🤖 自動抓取") && tasks().includes("在課輔系統開啟"), "爬蟲作業標示『自動抓取』並附原始頁面連結");
  ok(/期末專題[\s\S]*?（推測）/.test(tasks()) && tasks().includes("請到課輔系統確認"), "從日期範圍推測的截止時間標示『推測』");
  ok(get("#syncStatus").innerHTML.includes("上次爬蟲同步") && get("#syncStatus").innerHTML.includes("閱讀心得"), "設定頁顯示同步時間與爬蟲訊息");
  ok(get("#syncBanner").hidden === true, "剛同步時不顯示過期提醒");

  // 在 App 裡把作業一標成完成，再重新同步：作業一仍然是完成；期末專題已從課輔系統消失 → 移除；手動作業保留
  const li = { dataset: { id: "hw-1" } };
  clickOn({ "[data-act]": { dataset: { act: "done" }, closest: (s) => (s === "[data-id]" ? li : null) } });
  await tick();
  const crawl2 = { ...crawl1, generatedAt: new Date(now - 40 * H).toISOString(),
    tasks: [crawl1.tasks[0], { id: "hw-3", semester: "115-1", source: "crawler", course: "範例程式設計", title: "作業三", due: iso(now + 30 * H), dueConfidence: "labelled" }] };
  importText(crawl2); await tick();
  const mine = JSON.parse(store["pccu-reminder-mine"]);
  ok(mine.tasks.filter((t) => t.source === "crawler").map((t) => t.id).sort().join() === "hw-1,hw-3", "重新同步會取代先前爬到的作業（不會重複累加）");
  ok(mine.tasks.some((t) => t.id === "manual1"), "重新同步不會刪除手動新增的作業");
  ok(JSON.parse(store["pccu-reminder-state"]).done["hw-1"], "重新同步後保留你在 App 裡的完成標記");
  ok(get("#syncBanner").hidden === false && get("#syncBanner").textContent.includes("1 天前"), "同步超過 36 小時顯示過期提醒");

  // 公告：清單顯示預覽、點開顯示內文
  const nl = get("#notices").innerHTML;
  ok(nl.includes('data-notice="nA"') && nl.includes("範圍：第 1～6 章"), "公告清單可點並顯示內文預覽");
  ok(nl.includes("尚無內文"), "沒有內文的公告標示『尚無內文』");
  clickOn({ "[data-notice]": { dataset: { notice: "nA" } } });
  await tick();
  const sheet = get("#sheetBody").innerHTML;
  ok(get("#sheet").hidden === false, "點公告打開內文頁");
  ok(sheet.includes("範圍：第 1～6 章<br>"), "內文保留換行");
  ok(!sheet.includes("<img") && sheet.includes("&lt;img"), "內文裡的 HTML 只當文字顯示（不會執行）");
  ok(sheet.includes('<a href="https://example.invalid/info"'), "內文中的網址變成連結");
  ok(sheet.includes("考試範圍.pdf") && !sheet.includes("javascript:"), "附件連結顯示；javascript: 連結被擋掉");
  ok(sheet.includes("在課輔系統開啟"), "提供回到課輔系統的連結");
  ok(JSON.parse(store["pccu-reminder-state"]).read.nA && !get("#notices").innerHTML.includes('notice unread" data-notice="nA"'), "打開後標成已讀");
  clickOn({ id: "sheet" }); await tick();
  ok(get("#sheet").hidden === true, "點背景關閉內文頁");
  clickOn({ "[data-notice]": { dataset: { notice: "nB" } } }); await tick();
  ok(get("#sheetBody").innerHTML.includes("還沒有內文"), "沒有內文時說明原因");


  // 作業：清單顯示要求預覽，點標題打開內容要求
  ok(tasks().includes('data-open="hw-1"') && tasks().includes("📄 1. 寫出 operator&lt;&lt;"), "作業清單可點並顯示要求預覽");
  clickOn({ "[data-open]": { dataset: { open: "hw-1" } } }); await tick();
  const ts = get("#sheetBody").innerHTML;
  ok(get("#sheet").hidden === false && ts.includes("作業要求") && ts.includes("operator&lt;&lt;<br>2. 上傳"), "點作業打開內容要求（保留換行、HTML 只當文字）");
  ok(ts.includes('<a href="https://example.invalid/spec"') && ts.includes("在課輔系統開啟"), "要求中的網址變成連結，並可回課輔系統");
  clickOn({ "[data-open]": { dataset: { open: "manual1" } } }); await tick();
  ok(get("#sheetBody").innerHTML.includes("手動新增的作業，沒有說明"), "手動作業沒有說明時說明原因");
  const chk = { dataset: { open: "hw-3" }, };
  get("#sheet").hidden = true;
  clickOn({ "[data-open]": chk, "a, button": {} }); await tick();
  ok(get("#sheet").hidden === true, "點作業上的按鈕不會打開內容頁");

  console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
  process.exit(fail ? 1 : 0);
})();
