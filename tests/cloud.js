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
// 模擬 Claude Artifact 的資料庫：sync/latest 一份文件，可由測試推送新版本
let snapCb = null, errCb = null, subs = 0;
const FAKE_DB = { doc: (path) => ({ onSnapshot: (next, err) => { if (path === "sync/latest") { subs++; snapCb = next; errCb = err; } return () => {}; } }) };
const push = (data) => snapCb({ exists: !!data, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } });
if (process.env.BRIEF_WINDOW) {  // 模擬「已過每日總覽時間 10 分鐘」
  const d = new Date(Date.now() - 10 * 60000);
  store["pccu-reminder-settings"] = JSON.stringify({ briefOn: true, briefTime: String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") });
}
const ctx = {
  console, setInterval() {}, setTimeout, clearTimeout, Date, URLSearchParams, JSON, Math, Object, Set, Map, Number, String, Array, Promise, Error,
  window: { navigator: { standalone: false }, claude: { use: async (name) => (name === "db" ? FAKE_DB : null) } }, CSS: { escape: (x) => x },
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
  ok(get("#demoBanner").hidden === true && !get("#tasks").innerHTML.includes("作業三"), "Claude 網頁版不顯示示範資料");
  ok(get("#cloudBanner").hidden === false, "雲端資料到之前顯示載入中");
  ok(subs === 1, "只訂閱一次 sync/latest");
  ok(get("#notifStatus").textContent.includes("無法發送手機系統通知") && get("#btnNotif").hidden === true, "說明 Claude 網頁不能發手機通知，隱藏開啟通知按鈕");

  push(null); await tick();
  ok(get("#cloudBanner").textContent.includes("幫我爬蟲"), "資料庫還沒有資料時，提示跟 Claude 說「幫我爬蟲」");

  const H = 3600e3, now = Date.now(), p = (n) => String(n).padStart(2, "0");
  const iso = (t) => { const d = new Date(t); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  const v1 = { source: "crawler", generatedAt: "2026-10-27T20:30:00+08:00", semester: "115-1",
    schedule: [{ id: "s1", semester: "115-1", weekday: 1, start: "09:10", end: "12:00", course: "機率與統計", room: "大義館 0721", teacher: "" }],
    notices: [{ id: "n1", semester: "115-1", course: "資料結構", title: "期中考試", postedDate: "2026-10-27", read: false, content: "11/2 15:10 考試" }],
    tasks: [{ id: "hw-1", semester: "115-1", source: "crawler", course: "機率與統計", title: "EX1", due: iso(now + 50 * H), dueConfidence: "labelled", done: false }],
    report: [] };
  push(v1); await tick();
  ok(get("#tasks").innerHTML.includes("EX1") && get("#schedule").innerHTML.includes("機率與統計"), "收到雲端資料後自動顯示作業與課表");
  ok(msg.includes("已同步課輔系統：1 份作業、1 則公告"), "同步後顯示提示：" + msg);
  ok(get("#cloudBanner").hidden === true && get("#cloudStatus").textContent.includes("已開啟自動同步"), "同步後隱藏載入橫幅，設定頁顯示已開啟自動同步");

  // 在手機上標完成 → 同一份資料再送一次（例如重新整理）：不重複匯入、完成標記保留
  const li = { dataset: { id: "hw-1" } };
  clickHandlers.forEach((f) => f({ target: { closest: (s) => (s === "[data-act]" ? { dataset: { act: "done" }, closest: (q) => (q === "[data-id]" ? li : null) } : null) } }));
  await tick();
  msg = "";
  push(v1); await tick();
  ok(msg === "", "同一版資料不會重複匯入");
  ok(JSON.parse(store["pccu-reminder-state"]).done["hw-1"], "完成標記保留");

  // Claude 再爬一次：新作業出現、舊的完成標記仍在
  push({ ...v1, generatedAt: "2026-10-28T08:00:00+08:00", tasks: [...v1.tasks, { id: "hw-2", semester: "115-1", source: "crawler", course: "機率與統計", title: "Ex2", due: iso(now + 200 * H), dueConfidence: "labelled" }] });
  await tick();
  ok(get("#tasks").innerHTML.includes("Ex2") && JSON.parse(store["pccu-reminder-state"]).done["hw-1"], "新一次爬蟲的作業自動出現，完成標記仍保留");

  push({ source: "crawler", generatedAt: "x", schedule: [{ weekday: 9 }] }); await tick();
  ok(msg.includes("格式有誤") && get("#tasks").innerHTML.includes("Ex2"), "格式錯誤的資料不會蓋掉現有內容");
  errCb({ code: "revoked" }); await tick();
  ok(get("#cloudStatus").textContent.includes("讀不到"), "連線中斷時說明仍可使用上次同步的內容");
  console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
  process.exit(fail ? 1 : 0);
})();
