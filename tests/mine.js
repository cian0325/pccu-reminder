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
  const submit = (id, fields) => {
    const elements = {}; for (const [k, v] of Object.entries(fields)) elements[k] = { value: v };
    get("#toast").textContent = "";
    get(id).listeners.submit.forEach((f) => f({ preventDefault() {}, target: { elements, reset() {} } }));
    return get("#toast").textContent || null;
  };
  ok(get("#demoBanner").hidden === false, "示範資料模式：顯示『示範資料』橫幅");
  ok(get("#dataSource").textContent.includes("虛構"), "資料來源明確標示為虛構");

  // 新增我自己的課程與作業 → 自動切到「我的資料」
  const dow = String(new Date().getDay() || 1);
  submit("#formCourse", { course: "電腦網路", weekday: dow, start: "23:00", end: "23:50", room: "大義館 B202", teacher: "" });
  await tick();
  ok(get("#demoBanner").hidden === true, "改用我的資料後，橫幅消失");
  ok(!get("#nextClass").innerHTML.includes("程式設計"), "我的資料模式不會出現虛構的『程式設計（C++）』");
  ok(get("#nextClass").innerHTML.includes("電腦網路") && get("#nextClass").innerHTML.includes("大義館 B202"), "下一堂課與教室顯示我輸入的內容");
  ok(get("#nextClass").innerHTML.includes(encodeURIComponent("大義館")), "導航連結使用我輸入的館名");

  const due = new Date(Date.now() + 36 * 3600e3); const pad = (n) => String(n).padStart(2, "0");
  const dtl = due.getFullYear() + "-" + pad(due.getMonth() + 1) + "-" + pad(due.getDate()) + "T" + pad(due.getHours()) + ":" + pad(due.getMinutes());
  submit("#formTask", { course: "電腦網路", title: "實驗一報告", due: dtl });
  await tick();
  ok(get("#tasks").innerHTML.includes("實驗一報告"), "新增的作業出現在作業頁");
  ok(!/作業三|鏈結串列|期末報告|實驗報告</.test(get("#tasks").innerHTML.replace("實驗一報告","")), "不會出現任何虛構／舊學期作業");

  // 輸入錯誤
  ok(submit("#formCourse", { course: "X", weekday: "1", start: "10:00", end: "09:00", room: "R", teacher: "" }) !== null, "下課早於上課時間會被擋下");
  ok(submit("#formTask", { course: "X", title: "Y", due: "" }) !== null, "沒有截止時間會被擋下");

  // 學期歸屬
  const mine = JSON.parse(store["pccu-reminder-mine"]);
  ok(mine.tasks[0].semester === "115-1" && mine.schedule[0].semester === "115-1", "新增項目自動歸入目前學期 115-1");

  // 刪除
  const li = { dataset: { del: "tasks:" + mine.tasks[0].id } };
  const btn = { closest: (q) => (q === "[data-del]" ? li : null) };
  clickHandlers.forEach((f) => f({ target: { closest: (q) => (q === "[data-delbtn]" ? btn : null) } }));
  await tick();
  ok(JSON.parse(store["pccu-reminder-mine"]).tasks.length === 0 && !get("#tasks").innerHTML.includes("實驗一報告"), "可刪除已輸入的作業");

  // 切回示範資料
  get("#modeSel").value = "demo"; get("#modeSel").listeners.change.forEach((f) => f());
  await tick();
  ok(get("#demoBanner").hidden === false, "可切回示範資料");

  console.log(fail ? "\n" + fail + " 項失敗" : "\n全部通過");
  process.exit(fail ? 1 : 0);
})();