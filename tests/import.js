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
  const sample = {
    schedule: [
      { id: "s1", semester: "115-1", weekday: 1, start: "09:10", end: "12:00", course: "範例程式設計", room: "大典館 0101", teacher: "王小明" },
      { id: "s2", semester: "115-1", weekday: 2, start: "10:10", end: "12:00", course: "範例體育", room: "", teacher: "陳小玲" }
    ],
    notices: [
      { id: "n1", semester: "115-1", course: "範例程式設計", title: "期中考公告", postedDate: "2026-10-24", read: false },
      { id: "n2", semester: "115-1", course: "範例通識", title: "報告分組", postedDate: "2026-10-19", read: true }
    ],
    tasks: []
  };
  let msg = ""; { const t = get("#toast"); Object.defineProperty(t, "textContent", { set(v) { msg = v; this._t = v; }, get() { return this._t || ""; } }); }
  const run = (txt) => { get("#importText").value = txt; get("#btnImport").listeners.click.forEach((f) => f()); };

  run(JSON.stringify(sample)); await tick();
  ok(msg.includes("2 個上課時段") && msg.includes("2 則公告"), "匯入成功並回報筆數：" + msg);
  ok(get("#demoBanner").hidden === true, "匯入後切到『我的資料』，不再顯示示範橫幅");
  ok(!/微積分|鏈結串列|作業三/.test(get("#schedule").innerHTML + get("#tasks").innerHTML), "不含任何示範內容");
  ok(get("#schedule").innerHTML.includes("大典館 0101") && get("#schedule").innerHTML.includes("教室未標示"), "課表顯示教室；沒有教室顯示『教室未標示』");
  ok((get("#notices").innerHTML.match(/notice unread/g) || []).length === 1, "未讀公告 1 則（postedDate 字串已轉成時間）");

  // 再次匯入同學期：取代而不是重複
  run(JSON.stringify(sample)); await tick();
  const mine = JSON.parse(store["pccu-reminder-mine"]);
  ok(mine.schedule.length === 2 && mine.notices.length === 2, "同學期重複匯入會取代，不會重複累加");

  // 手動新增的作業不會被匯入覆蓋；作業只新增、依內容去重
  const due = Date.now() + 5 * 3600e3;
  const withTask = { ...sample, tasks: [{ id: "t1", semester: "115-1", course: "範例程式設計", title: "作業一", due }] };
  run(JSON.stringify(withTask)); await tick();
  run(JSON.stringify(withTask)); await tick();
  ok(JSON.parse(store["pccu-reminder-mine"]).tasks.length === 1, "同一份作業重複匯入只會有一份");

  // 錯誤輸入
  run("不是 JSON"); await tick();
  ok(msg.includes("JSON"), "非 JSON 會提示錯誤：" + msg);
  run(JSON.stringify({ schedule: [{ weekday: 1, start: "9點", end: "12:00", course: "X" }] })); await tick();
  ok(msg.includes("格式不正確"), "時間格式錯誤會被擋下：" + msg);
  run(JSON.stringify({ schedule: [], notices: [], tasks: [] })); await tick();
  ok(msg.includes("沒有可匯入"), "空檔案會提示：" + msg);

  console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
  process.exit(fail ? 1 : 0);
})();
