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
{
  const sched = [0, 1, 2, 3, 4, 5, 6].map((wd) => ({ id: "w" + wd, semester: "115-1", weekday: wd, start: "23:58", end: "23:59", course: "課W" + wd, room: "大義館 0" + wd + "01", teacher: "" }));
  store["pccu-reminder-mine"] = JSON.stringify({ schedule: sched, tasks: [], notices: [] });
  store["pccu-reminder-mode"] = "mine";
}
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
{
  const D = 86400000, ymd = (t) => { const d = new Date(t); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const now = Date.now(), wdPlus3 = (new Date(now).getDay() + 3) % 7;
  ctx.window.SCHOOL_CALENDAR = {
    loaded: true, source: "測試行事曆", sourceUrl: "https://example.invalid/cal.pdf",
    semesters: { "115-1": { start: ymd(now - 30 * D), end: ymd(now + 5 * D) } },
    events: [
      { start: ymd(now), title: "測試放假日", type: "holiday", noClass: true },
      { start: ymd(now + D), title: "調整上課", type: "makeup", followsWeekday: wdPlus3 },
      { start: ymd(now + 2 * D), end: ymd(now + 3 * D), title: "期中考", type: "exam" },
      { start: ymd(now - 20 * D), title: "已過去的加退選", type: "course" },
      { start: "不是日期", title: "壞資料", type: "other" },
      { start: ymd(now + 4 * D), title: "未知類型", type: "weird" }
    ]
  };
  ctx.__T = { now, D, ymd, wdPlus3 };
}
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
  const { now, D, ymd, wdPlus3 } = ctx.__T;
  const next = get("#nextClass").innerHTML, brief = get("#brief").innerHTML;

  ok(next.includes("今天停課") && next.includes("測試放假日"), "首頁顯示今天停課與原因");
  ok(next.includes("課W" + wdPlus3), "下一堂課跳過停課日，並依補課日改上星期" + "日一二三四五六"[wdPlus3] + "的課");
  ok(brief.includes("今天停課（測試放假日）"), "今日總覽：今天停課");
  ok(brief.includes("明天：調整上課"), "今日總覽：列出明天的行事曆事件");

  const occ = ctx.occurrences(JSON.parse(store["pccu-reminder-mine"]).schedule, new Date(now - (new Date(now).getHours() * 3600e3)), 14);
  const days = new Set(occ.map((o) => ymd(o.startAt)));
  ok(!days.has(ymd(now)), "停課日沒有任何上課時段");
  ok(occ.filter((o) => ymd(o.startAt) === ymd(now + D)).every((o) => o.course === "課W" + wdPlus3), "補課日只排該上的那一天的課");
  ok(!days.has(ymd(now + 6 * D)) && days.has(ymd(now + 5 * D)), "學期最後一天有課，學期結束後（寒暑假）沒有課");

  const cal = get("#calList").innerHTML;
  ok(cal.includes("期中考") && cal.includes("調整上課") && cal.includes("測試放假日"), "行事曆列出未來事件");
  ok(!cal.includes("已過去的加退選"), "預設隱藏已過去的事件");
  ok(!cal.includes("壞資料"), "日期格式錯誤的事件被略過");
  ok(cal.includes("未知類型") && cal.includes("📌"), "未知類型歸為『其他』");
  ok(cal.includes("cal-month"), "依月份分組");
  ok(get("#calStatus").innerHTML.includes("以學校公告為準"), "顯示資料來源與免責說明");
  ok((get("#homeCal").innerHTML.match(/class="cal /g) || []).length === 3, "首頁顯示 3 筆近期行事曆");

  get("#calPast").checked = true; get("#calPast").listeners.change.forEach((f) => f()); await tick();
  ok(get("#calList").innerHTML.includes("已過去的加退選"), "勾選後顯示已過去的事件");

  const notes = ctx.__notes || [];
  console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
  process.exit(fail ? 1 : 0);
})();
