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
vm.runInContext(fs.readFileSync(path.join(dir, "calendar.js"), "utf8"), ctx);
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
  // 每天 08:10 一堂課，方便看哪幾天有課
  const sched = [0, 1, 2, 3, 4, 5, 6].map((wd) => ({ weekday: wd, start: "08:10", end: "09:00", course: "課" + wd, room: "R" }));
  const daysWithClass = (y, m, d, n) => new Set(ctx.occurrences(sched, new Date(y, m - 1, d, 0, 0), n).map((o) => ctx.ymd(o.startAt)));

  const cal = ctx.calendar();
  ok(cal.loaded === true && cal.events.length === 70, "載入 115 學年度行事曆：70 筆事件");

  let w = daysWithClass(2026, 10, 24, 7);
  ok(!w.has("2026-10-25") && !w.has("2026-10-26") && w.has("2026-10-27"), "10/25、10/26 光復節及補假停課，10/27 恢復上課");
  w = daysWithClass(2026, 10, 5, 7);
  ok(!w.has("2026-10-09") && !w.has("2026-10-10") && w.has("2026-10-08"), "10/9 國慶補假、10/10 國慶停課");
  w = daysWithClass(2026, 9, 7, 14);
  ok(!w.has("2026-09-13") && w.has("2026-09-14"), "9/14 開始上課日之前沒有課");
  w = daysWithClass(2027, 1, 11, 14);
  ok(w.has("2027-01-17") && !w.has("2027-01-18") && !w.has("2027-01-24"), "1/17 第 18 週結束後進入寒假，不再有上課提醒");
  w = daysWithClass(2027, 2, 15, 14);
  ok(!w.has("2027-02-19") && w.has("2027-02-22"), "第 2 學期 2/22 開始上課");
  w = daysWithClass(2027, 4, 1, 7);
  ok(!w.has("2027-04-05") && !w.has("2027-04-06") && w.has("2027-04-07"), "4/5 掃墓節、4/6 兒童節補假停課");
  ok(ctx.nextClass(sched, new Date(2027, 0, 25, 9)) === null, "寒假期間『下一堂課』顯示近期沒有課程");

  ok(ctx.noClassReason("2027-02-10").title.includes("全校休假"), "春節期間停課原因：全校休假");
  ok(ctx.eventsOn("2026-11-04").some((e) => e.title === "期中考試週"), "11/4 落在期中考試週");
  ok(ctx.eventsOn("2027-01-04").some((e) => e.title.includes("外文") && e.type === "exam"), "1/4 外文期末會考");

  const list = get("#calList").innerHTML;
  ok(!list.includes("2026 年 8 月"), "預設不顯示已過去的月份");
  ok(list.includes("研究生") && list.includes("期中考試週"), "行事曆列出未來事件，研究生事件加上標籤");
  ok(!get("#homeCal").innerHTML.includes("研究生"), "首頁不顯示只適用研究生的事件");
  ok(get("#calStatus").innerHTML.includes("115calendar.pdf"), "顯示行事曆來源");
  console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
  process.exit(fail ? 1 : 0);
})();
