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
  const tasks = () => get("#tasks").innerHTML;
  const home = () => get("#homeDeadlines").innerHTML;
  ok(!tasks().includes("期末報告") && !tasks().includes("實驗報告"), "舊學期作業不會顯示");
  ok(tasks().indexOf("作業三") < tasks().indexOf("實作鏈結串列"), "依優先度：快截止的排前面");
  ok(get("#navLink") !== undefined && get("#nextClass").innerHTML.includes("maps.apple.com"), "下一堂課有導航連結");
  ok(get("#brief").innerHTML.includes("今日總覽"), "今日總覽已顯示");
  ok(get("#stats").innerHTML.includes("本週統計"), "週統計已顯示");

  click("a3", "star"); await tick();
  ok(/習題 4\.1[\s\S]*?優先度 中/.test(tasks()), "標為重要後優先度由低升為中");

  click("a1", "stage", { stage: "2" }); await tick();
  ok(tasks().includes('width:75%'), "C++ 進度條更新（除錯測試 75%）");

  click("a1", "note"); await tick();
  ok(get("#sheet").hidden === false && get("#sheetBody").innerHTML.includes("儲存備註"), "備註在頁內編輯（不用 prompt）");
  get("#noteText").value = "卡在 friend 宣告";
  get("#noteForm").listeners.submit.forEach((f) => f({ preventDefault() {} }));
  await tick();
  ok(tasks().includes("卡在 friend 宣告"), "備註已儲存並顯示");

  click("a2", "snooze"); await tick();
  ok(tasks().includes("將於") && JSON.parse(store["pccu-reminder-state"]).snooze.a2 > Date.now(), "貪睡已設定 1 小時");

  const before = notes.length;
  click("a1", "done"); await tick();
  ok(tasks().includes("☑") && JSON.parse(store["pccu-reminder-state"]).done.a1, "標記完成");
  ok(!home().includes("作業三"), "完成後從首頁移除");
  click("a1", "done"); await tick();
  ok(!JSON.parse(store["pccu-reminder-state"]).done.a1, "再按一次可取消完成");

  // 伺服器標記已完成的作業不能被取消
  click("a4", "done"); await tick();
  ok(!JSON.parse(store["pccu-reminder-state"]).done.a4, "伺服器已完成的作業不被本機覆蓋");

  // 提醒：先把 init 的第一次 checkReminders 結果看一下
  ok(notes.some((n) => n.t === "作業截止提醒" && n.body.includes("作業三")), "前景提醒：作業截止提醒已觸發");
  const briefs = notes.filter((n) => n.t.startsWith("今日總覽"));
  if (process.env.BRIEF_WINDOW) {
    ok(briefs.length === 1 && JSON.parse(store["pccu-reminder-state"]).briefDate !== "", "每日總覽在設定時間後觸發且只發 1 次");
  } else {
    ok(briefs.length === 0, "超過設定時間 3 小時後開啟 App，不補發每日總覽");
  }
  ok(!notes.some((n) => /期末報告|實驗報告/.test(n.body)), "舊學期作業不會發提醒");
  ok(notes.find((n) => n.t === "作業截止提醒").data.url.includes("task=a1"), "通知可深連結到該作業");

  // 貪睡到期補提醒：把 a2 的貪睡改成過去
  const st = JSON.parse(store["pccu-reminder-state"]); st.snooze.a2 = Date.now() - 1000;
  store["pccu-reminder-state"] = JSON.stringify(st);
  console.log("(貪睡到期需重新載入狀態，由 App 重新開啟時處理；此處僅驗證設定值寫入)");
  console.log(fail ? `\n${fail} 項失敗` : "\n全部通過");
  process.exit(fail ? 1 : 0);
})();
