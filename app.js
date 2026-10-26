"use strict";

const WEEKDAY_NAMES = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
const $ = (s) => document.querySelector(s);
const HOUR = 3600 * 1000;

// ---------- 資料 ----------
// 之後換成 fetch("/api/summary")；失敗時退回示範資料
async function loadData() {
  try {
    if (window.API_BASE) {
      const r = await fetch(window.API_BASE + "/api/summary", { credentials: "include" });
      if (r.ok) return await r.json();
    }
  } catch (e) { /* fall through */ }
  return window.DEMO_DATA;
}

// ---------- 時間工具 ----------
function parseHM(hm, base) {
  const [h, m] = hm.split(":").map(Number);
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}

// 回傳所有上課時段的實際發生時間，往後展開 14 天
function occurrences(schedule, from = new Date(), days = 14) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const day = new Date(from);
    day.setDate(from.getDate() + i);
    for (const s of schedule) {
      if (s.weekday === day.getDay()) {
        out.push({ ...s, startAt: parseHM(s.start, day), endAt: parseHM(s.end, day) });
      }
    }
  }
  return out.sort((a, b) => a.startAt - b.startAt);
}

function nextClass(schedule, now = new Date()) {
  return occurrences(schedule, now).find((o) => o.endAt > now) || null;
}

function relTime(ms) {
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60000);
  let t;
  if (m < 60) t = m + " 分鐘";
  else if (m < 60 * 24) t = Math.floor(m / 60) + " 小時" + (m % 60 ? " " + (m % 60) + " 分" : "");
  else t = Math.floor(m / 1440) + " 天 " + Math.floor((m % 1440) / 60) + " 小時";
  return ms >= 0 ? "還有 " + t : "已逾期 " + t;
}

function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAY_NAMES[d.getDay()]}）${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- 畫面 ----------
let DATA = null;

function dueTag(t, now) {
  if (t.done) return '<span class="tag done">已完成</span>';
  const left = t.due - now;
  if (left < 0) return '<span class="tag urgent">已逾期</span>';
  if (left < 24 * HOUR) return '<span class="tag urgent">24 小時內</span>';
  if (left < 3 * 24 * HOUR) return '<span class="tag soon">3 天內</span>';
  return '<span class="tag ok">充裕</span>';
}

function taskItem(t, now) {
  return `<li><div class="title">${esc(t.title)}${dueTag(t, now)}</div>
    <div class="sub">${esc(t.course)}・${fmtDate(t.due)}・${t.done ? "已繳交" : relTime(t.due - now)}</div></li>`;
}

function noticeItem(n) {
  return `<li class="notice ${n.read ? "" : "unread"}"><div class="title">${esc(n.title)}</div>
    <div class="sub">${esc(n.course)}・${fmtDate(n.posted)}</div></li>`;
}

function renderNextClass(now) {
  const el = $("#nextClass");
  const c = nextClass(DATA.schedule, new Date(now));
  if (!c) { el.innerHTML = '<div class="label">下一堂課</div><div class="name">近期沒有課程</div>'; return; }
  const ongoing = c.startAt <= now;
  el.innerHTML = `<div class="label">${ongoing ? "正在上課" : "下一堂課"}</div>
    <div class="name">${esc(c.course)}</div>
    <div class="meta">📍 ${esc(c.room)}　🕘 ${fmtDate(c.startAt)} – ${c.end}</div>
    <div class="meta">${ongoing ? "進行中" : relTime(c.startAt - now) + "開始"}・${esc(c.teacher || "")}</div>`;
}

function renderSchedule(now) {
  const today = new Date(now).getDay();
  const days = [1, 2, 3, 4, 5];
  $("#schedule").innerHTML = days.map((wd) => {
    const slots = DATA.schedule.filter((s) => s.weekday === wd).sort((a, b) => a.start.localeCompare(b.start));
    const body = slots.length
      ? slots.map((s) => `<div class="slot"><div class="time">${s.start}–${s.end}</div>
          <div><div>${esc(s.course)}</div><div class="room">${esc(s.room)}</div></div></div>`).join("")
      : '<div class="muted">沒有課</div>';
    return `<div class="day ${wd === today ? "today" : ""}"><h3>${WEEKDAY_NAMES[wd]}${wd === today ? "（今天）" : ""}</h3>${body}</div>`;
  }).join("");
}

function render() {
  const now = Date.now();
  const open = DATA.tasks.filter((t) => !t.done).sort((a, b) => a.due - b.due);
  const all = [...DATA.tasks].sort((a, b) => (a.done - b.done) || (a.due - b.due));
  const notices = [...DATA.notices].sort((a, b) => b.posted - a.posted);

  renderNextClass(now);
  $("#homeDeadlines").innerHTML = open.slice(0, 3).map((t) => taskItem(t, now)).join("") || '<li class="muted">沒有待繳作業 🎉</li>';
  $("#homeNotices").innerHTML = notices.slice(0, 3).map(noticeItem).join("");
  renderSchedule(now);
  $("#tasks").innerHTML = all.map((t) => taskItem(t, now)).join("");
  $("#notices").innerHTML = notices.map(noticeItem).join("");
  $("#dataSource").textContent = "目前資料來源：" + (DATA.source === "demo" ? "示範資料" : "課輔系統（後端同步）");
  $("#clock").textContent = new Date(now).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
}

// ---------- 導覽 ----------
document.querySelectorAll("nav button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + b.dataset.view));
    window.scrollTo(0, 0);
  });
});

// ---------- 通知設定 ----------
const SETTINGS_KEY = "pccu-reminder-settings";

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
function saveSettings() {
  const leads = [...document.querySelectorAll("[data-lead]")].filter((c) => c.checked).map((c) => Number(c.dataset.lead));
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ leads, classLead: Number($("#classLead").value) }));
}
function applySettings() {
  const s = loadSettings();
  if (s.leads) document.querySelectorAll("[data-lead]").forEach((c) => (c.checked = s.leads.includes(Number(c.dataset.lead))));
  if (s.classLead) $("#classLead").value = s.classLead;
}
document.querySelectorAll("[data-lead], #classLead").forEach((el) => el.addEventListener("change", saveSettings));

const isStandalone = window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

function updateNotifStatus() {
  const el = $("#notifStatus");
  if (!("Notification" in window)) {
    el.textContent = "此瀏覽器不支援通知。iPhone 請以「加入主畫面」方式開啟。";
    return;
  }
  const map = { granted: "通知已開啟 ✅", denied: "通知被封鎖，請到 iOS 設定 → 通知 → 課輔提醒 開啟", default: "尚未開啟通知" };
  el.textContent = map[Notification.permission];
  $("#iosHint").hidden = !(isIOS && !isStandalone);
}

async function showNotification(title, body, tag) {
  const reg = await navigator.serviceWorker.ready;
  reg.showNotification(title, { body, tag, icon: "icons/icon-192.png", badge: "icons/icon-192.png" });
}

$("#btnNotif").addEventListener("click", async () => {
  if (!("Notification" in window)) return updateNotifStatus();
  await Notification.requestPermission();
  updateNotifStatus();
});
$("#btnTest").addEventListener("click", async () => {
  if (Notification.permission !== "granted") return alert("請先開啟通知");
  const t = DATA.tasks.filter((x) => !x.done).sort((a, b) => a.due - b.due)[0];
  await showNotification("作業快截止了", t ? `${t.course}：${t.title}（${relTime(t.due - Date.now())}）` : "測試通知", "test");
});

// ---------- 前景檢查提醒（App 開著時的備援；背景推播由後端 Web Push 負責） ----------
function checkReminders() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const s = loadSettings();
  const leads = s.leads || [1440, 180];
  const classLead = s.classLead || 30;
  const now = Date.now();
  const fired = JSON.parse(localStorage.getItem("fired") || "{}");
  const fire = (key, title, body) => {
    if (fired[key]) return;
    fired[key] = now;
    localStorage.setItem("fired", JSON.stringify(fired));
    showNotification(title, body, key);
  };
  for (const t of DATA.tasks) {
    if (t.done) continue;
    for (const lead of leads) {
      const left = t.due - now;
      if (left > 0 && left <= lead * 60000) fire(`task-${t.id}-${lead}`, "作業截止提醒", `${t.course}：${t.title}（${relTime(left)}）`);
    }
  }
  const c = nextClass(DATA.schedule, new Date(now));
  if (c && c.startAt > now && c.startAt - now <= classLead * 60000) {
    fire(`class-${c.course}-${c.startAt.getTime()}`, "快上課了", `${c.course}　📍${c.room}（${relTime(c.startAt - now)}）`);
  }
}

// ---------- 啟動 ----------
(async function init() {
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("sw.js"); } catch (e) { console.warn("SW 註冊失敗", e); }
  }
  DATA = await loadData();
  applySettings();
  updateNotifStatus();
  render();
  checkReminders();
  setInterval(() => { render(); checkReminders(); }, 60 * 1000);
})();
