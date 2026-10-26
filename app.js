"use strict";

const WEEKDAY_NAMES = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
const $ = (s) => document.querySelector(s);
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// C++ 作業的開發階段（對應進度條）
const STAGES = [
  { label: "未開始", pct: 0 },
  { label: "寫程式中", pct: 40 },
  { label: "除錯測試", pct: 75 },
  { label: "整理繳交", pct: 90 }
];

// ---------- 學期 ----------
// 民國年 = 西元年 - 1911。第 1 學期：8 月～隔年 1 月；第 2 學期：2 月～7 月。
function currentSemester(d = new Date()) {
  const y = d.getFullYear() - 1911, m = d.getMonth() + 1;
  if (m >= 8) return `${y}-1`;
  if (m === 1) return `${y - 1}-1`;
  return `${y - 1}-2`;
}

function activeSemester() {
  const s = loadSettings();
  return s.semester && s.semester !== "auto" ? s.semester : currentSemester();
}

// 只保留目前學期；沒有 semester 欄位的資料視為屬於目前學期
function filterSemester(data, sem) {
  const keep = (x) => !x.semester || x.semester === sem;
  const all = [...data.schedule, ...data.tasks, ...data.notices];
  const semesters = [...new Set(all.map((x) => x.semester).filter(Boolean))].sort().reverse();
  return {
    ...data,
    semesters,
    schedule: data.schedule.filter(keep),
    tasks: data.tasks.filter(keep),
    notices: data.notices.filter(keep)
  };
}

// ---------- 本機狀態（完成、貪睡、重要、進度、已發送記錄） ----------
const STATE_KEY = "pccu-reminder-state";
const emptyState = () => ({ done: {}, snooze: {}, star: {}, progress: {}, fired: {}, briefDate: "", sort: "prio" });
let state = loadState();

function loadState() {
  try { return Object.assign(emptyState(), JSON.parse(localStorage.getItem(STATE_KEY)) || {}); } catch { return emptyState(); }
}
function saveState() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* 私密瀏覽等情況 */ }
}

// 把本機狀態合併進任務；伺服器標記為已完成的作業不能在本機取消
function mergeLocal(data) {
  return {
    ...data,
    tasks: data.tasks.map((t) => ({
      ...t,
      serverDone: !!t.done,
      done: !!t.done || !!state.done[t.id],
      doneAt: t.doneAt || state.done[t.id] || null,
      star: !!state.star[t.id],
      prog: state.progress[t.id] || { stage: 0, note: "" }
    }))
  };
}

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

let RAW = null;
let DATA = null;
function rebuild() {
  DATA = mergeLocal(filterSemester(RAW, activeSemester()));
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

function dateKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- 優先度 ----------
// 與 server-cpp/reminder_planner.cpp 的 priorityScore() 使用相同公式。
// 時間越近分數越高（指數衰減，半衰期約 50 小時）；重要 +25；進度越高最多扣 30%。
function priorityScore(t, now) {
  if (t.done) return -1;
  const hoursLeft = (t.due - now) / HOUR;
  let score = hoursLeft <= 0 ? 100 : 100 * Math.exp(-hoursLeft / 72);
  const pct = STAGES[t.prog.stage || 0].pct / 100;
  score *= 1 - 0.3 * pct;
  if (t.star) score += 25;
  return Math.min(125, score);
}

function priorityLevel(score) {
  if (score >= 70) return { k: "high", label: "高" };
  if (score >= 35) return { k: "mid", label: "中" };
  return { k: "low", label: "低" };
}

// ---------- 每日總覽 ----------
function buildBrief(now) {
  const d = new Date(now);
  const todays = DATA.schedule.filter((s) => s.weekday === d.getDay()).sort((a, b) => a.start.localeCompare(b.start));
  const dueSoon = DATA.tasks.filter((t) => !t.done && t.due > now && t.due - now <= DAY).sort((a, b) => a.due - b.due);
  const overdue = DATA.tasks.filter((t) => !t.done && t.due <= now);
  const unread = DATA.notices.filter((n) => !n.read).length;

  const lines = [];
  if (todays.length) lines.push(`🎓 今天 ${todays.length} 堂課：` + todays.map((s) => `${s.start} ${s.course}（${s.room}）`).join("、"));
  else lines.push("🎓 今天沒有課");
  if (dueSoon.length) lines.push(`⏰ 24 小時內截止 ${dueSoon.length} 份：` + dueSoon.map((t) => t.title).join("、"));
  else lines.push("⏰ 24 小時內沒有作業截止");
  if (overdue.length) lines.push(`⚠️ 已逾期未完成 ${overdue.length} 份`);
  if (unread) lines.push(`📢 未讀公告 ${unread} 則`);

  let body = todays.length ? `今天 ${todays.length} 堂課，第一堂 ${todays[0].start} ${todays[0].course}（${todays[0].room}）。` : "今天沒有課。";
  body += dueSoon.length ? `24 小時內有 ${dueSoon.length} 份作業截止。` : "24 小時內沒有作業截止。";
  if (unread) body += `未讀公告 ${unread} 則。`;
  return { title: `今日總覽 ${fmtDate(now).split("）")[0]}）`, body, lines };
}

// ---------- 週統計 ----------
function weekStart(now) {
  const d = new Date(now);
  const diff = (d.getDay() + 6) % 7; // 週一為一週開頭
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - diff);
  return d.getTime();
}

function computeStats(now) {
  const ws = weekStart(now);
  const perDay = [0, 0, 0, 0, 0, 0, 0]; // 週一 … 週日
  const timed = DATA.tasks.filter((t) => t.done && t.doneAt);
  let doneWeek = 0;
  for (const t of timed) {
    if (t.doneAt >= ws && t.doneAt < ws + 7 * DAY) {
      perDay[(new Date(t.doneAt).getDay() + 6) % 7]++;
      doneWeek++;
    }
  }
  const early = timed.filter((t) => t.due - t.doneAt >= DAY).length;
  const lastDay = timed.length - early;
  const pending = DATA.tasks.filter((t) => !t.done && t.due > now).length;
  const overdue = DATA.tasks.filter((t) => !t.done && t.due <= now).length;
  return { perDay, doneWeek, early, lastDay, pending, overdue, timedTotal: timed.length };
}

// ---------- 畫面 ----------
function dueTag(t, now) {
  if (t.done) return '<span class="tag done">已完成</span>';
  const left = t.due - now;
  if (left < 0) return '<span class="tag urgent">已逾期</span>';
  if (left < DAY) return '<span class="tag urgent">24 小時內</span>';
  if (left < 3 * DAY) return '<span class="tag soon">3 天內</span>';
  return '<span class="tag ok">充裕</span>';
}

function taskItem(t, now, full) {
  const lv = t.done ? { k: "done", label: "" } : priorityLevel(priorityScore(t, now));
  const stageIdx = t.prog.stage || 0;
  let h = `<li class="task lv-${lv.k}" data-id="${esc(t.id)}">
    <div class="title"><button class="chk" data-act="done" aria-label="切換完成"${t.serverDone ? " disabled" : ""}>${t.done ? "☑" : "☐"}</button>
      <span class="ttl">${esc(t.title)}${t.star ? " ⭐" : ""}</span>${dueTag(t, now)}</div>
    <div class="sub">${esc(t.course)}・${fmtDate(t.due)}・${t.done ? "已繳交" : relTime(t.due - now)}${t.done ? "" : `・優先度 ${lv.label}`}</div>`;
  if (full && !t.done) {
    h += `<div class="bar" title="${STAGES[stageIdx].label}"><i style="width:${STAGES[stageIdx].pct}%"></i></div>
      <div class="chips">${STAGES.map((s, i) => `<button class="chip${i === stageIdx ? " on" : ""}" data-act="stage" data-stage="${i}">${s.label}</button>`).join("")}</div>
      <div class="actions">
        <button data-act="star">${t.star ? "取消重要" : "標為重要"}</button>
        <button data-act="snooze">1 小時後再提醒</button>
        <button data-act="note">備註</button>
      </div>`;
    if (t.prog.note) h += `<div class="note">📝 ${esc(t.prog.note)}</div>`;
    const sn = state.snooze[t.id];
    if (sn && sn > now) h += `<div class="sub">⏰ 將於 ${fmtDate(sn)} 再提醒</div>`;
  }
  return h + "</li>";
}

function noticeItem(n) {
  return `<li class="notice ${n.read ? "" : "unread"}"><div class="title">${esc(n.title)}</div>
    <div class="sub">${esc(n.course)}・${fmtDate(n.posted)}</div></li>`;
}

function mapUrl(room) {
  const building = String(room).split(/\s+/)[0];
  return "https://maps.apple.com/?q=" + encodeURIComponent("中國文化大學 " + building);
}

function renderNextClass(now) {
  const el = $("#nextClass");
  const c = nextClass(DATA.schedule, new Date(now));
  if (!c) { el.innerHTML = '<div class="label">下一堂課</div><div class="name">近期沒有課程</div>'; return; }
  const ongoing = c.startAt <= now;
  el.innerHTML = `<div class="label">${ongoing ? "正在上課" : "下一堂課"}</div>
    <div class="name">${esc(c.course)}</div>
    <div class="meta">📍 ${esc(c.room)}　🕘 ${fmtDate(c.startAt)} – ${c.end}</div>
    <div class="meta">${ongoing ? "進行中" : relTime(c.startAt - now) + "開始"}・${esc(c.teacher || "")}</div>
    <a class="btn secondary small" id="navLink" href="${mapUrl(c.room)}" target="_blank" rel="noopener">🧭 導航到教室</a>`;
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

function renderBrief(now) {
  const b = buildBrief(now);
  $("#brief").innerHTML = `<div class="label">今日總覽</div>` + b.lines.map((l) => `<div class="brief-line">${esc(l)}</div>`).join("");
}

function renderStats(now) {
  const s = computeStats(now);
  const max = Math.max(1, ...s.perDay);
  const names = ["一", "二", "三", "四", "五", "六", "日"];
  const cols = s.perDay.map((n, i) => `<div class="col"><em>${n || ""}</em><i style="height:${Math.round((n / max) * 56) + 2}px"></i><span>${names[i]}</span></div>`).join("");
  const earlyPct = s.timedTotal ? Math.round((s.early / s.timedTotal) * 100) : 0;
  $("#stats").innerHTML = `<div class="label">本週統計</div>
    <div class="chart">${cols}</div>
    <div class="stat-row"><span>本週完成</span><b>${s.doneWeek} 份</b></div>
    <div class="stat-row"><span>待繳 / 逾期</span><b>${s.pending} / ${s.overdue}</b></div>
    <div class="stat-row"><span>提早（24 小時前）完成</span><b>${s.timedTotal ? earlyPct + "%" : "—"}</b></div>
    <div class="stat-row"><span>最後 24 小時才完成</span><b>${s.timedTotal ? s.lastDay + " 份" : "—"}</b></div>`;
}

function sortedTasks(now, mode) {
  const list = [...DATA.tasks];
  if (mode === "time") return list.sort((a, b) => (a.done - b.done) || (a.due - b.due));
  return list.sort((a, b) => (a.done - b.done) || (priorityScore(b, now) - priorityScore(a, now)) || (a.due - b.due));
}

function render() {
  const now = Date.now();
  const home = sortedTasks(now, "prio").filter((t) => !t.done);
  const notices = [...DATA.notices].sort((a, b) => b.posted - a.posted);

  renderNextClass(now);
  renderBrief(now);
  $("#homeDeadlines").innerHTML = home.slice(0, 3).map((t) => taskItem(t, now, false)).join("") || '<li class="muted">沒有待繳作業 🎉</li>';
  $("#homeNotices").innerHTML = notices.slice(0, 3).map(noticeItem).join("");
  renderStats(now);
  renderSchedule(now);
  $("#tasks").innerHTML = sortedTasks(now, state.sort).map((t) => taskItem(t, now, true)).join("") || '<li class="muted">這個學期沒有作業</li>';
  document.querySelectorAll("#sortSeg button").forEach((b) => b.classList.toggle("on", b.dataset.sort === state.sort));
  $("#notices").innerHTML = notices.map(noticeItem).join("");
  $("#dataSource").textContent = "目前資料來源：" + (DATA.source === "demo" ? "示範資料" : "課輔系統（後端同步）");
  $("#clock").textContent = activeSemester() + "・" + new Date(now).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
}

// ---------- 導覽 ----------
function switchView(name) {
  document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("active", x.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  window.scrollTo(0, 0);
}
document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));

// ---------- 作業互動（事件委派） ----------
document.addEventListener("click", (e) => {
  const sortBtn = e.target.closest("#sortSeg button");
  if (sortBtn) { state.sort = sortBtn.dataset.sort; saveState(); render(); return; }

  const b = e.target.closest("[data-act]");
  if (!b) return;
  const li = b.closest("[data-id]");
  if (!li) return;
  const id = li.dataset.id;
  const t = DATA.tasks.find((x) => x.id === id);
  if (!t) return;

  switch (b.dataset.act) {
    case "done":
      if (t.serverDone) return;
      if (state.done[id]) delete state.done[id]; else { state.done[id] = Date.now(); delete state.snooze[id]; }
      break;
    case "star":
      if (state.star[id]) delete state.star[id]; else state.star[id] = true;
      break;
    case "snooze":
      state.snooze[id] = Date.now() + HOUR;
      break;
    case "stage": {
      const p = state.progress[id] || { stage: 0, note: "" };
      p.stage = Number(b.dataset.stage);
      state.progress[id] = p;
      break;
    }
    case "note": {
      const p = state.progress[id] || { stage: 0, note: "" };
      const v = prompt("備註（例如：卡在 operator<< 的 friend 宣告）", p.note || "");
      if (v === null) return;
      p.note = v.trim().slice(0, 200);
      state.progress[id] = p;
      break;
    }
    default: return;
  }
  saveState();
  rebuild();
  render();
});

// ---------- 設定 ----------
const SETTINGS_KEY = "pccu-reminder-settings";

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
function saveSettings() {
  const leads = [...document.querySelectorAll("[data-lead]")].filter((c) => c.checked).map((c) => Number(c.dataset.lead));
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      leads,
      classLead: Number($("#classLead").value),
      semester: $("#semesterSel").value,
      briefOn: $("#briefOn").checked,
      briefTime: $("#briefTime").value || "07:30"
    }));
  } catch { /* ignore */ }
}
function applySettings() {
  const s = loadSettings();
  if (s.leads) document.querySelectorAll("[data-lead]").forEach((c) => (c.checked = s.leads.includes(Number(c.dataset.lead))));
  if (s.classLead) $("#classLead").value = s.classLead;
  $("#briefOn").checked = s.briefOn !== false;
  $("#briefTime").value = s.briefTime || "07:30";
  fillSemesterSelect(s.semester || "auto");
}

function fillSemesterSelect(selected) {
  const list = RAW.semesters || [...new Set([...RAW.schedule, ...RAW.tasks, ...RAW.notices].map((x) => x.semester).filter(Boolean))].sort().reverse();
  const opts = [`<option value="auto">自動（目前學期 ${currentSemester()}）</option>`].concat(list.map((x) => `<option value="${x}">${x}</option>`));
  $("#semesterSel").innerHTML = opts.join("");
  $("#semesterSel").value = selected;
}

$("#semesterSel").addEventListener("change", () => { saveSettings(); rebuild(); render(); });
document.querySelectorAll("[data-lead], #classLead, #briefOn, #briefTime").forEach((el) => el.addEventListener("change", saveSettings));

$("#btnReset").addEventListener("click", () => {
  if (!confirm("清除本機的完成、進度、重要、備註與提醒記錄？")) return;
  state = emptyState();
  saveState();
  rebuild();
  render();
});

// ---------- 通知 ----------
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

async function showNotification(title, body, tag, url) {
  const reg = await navigator.serviceWorker.ready;
  reg.showNotification(title, { body, tag, icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { url: url || "./" } });
}

$("#btnNotif").addEventListener("click", async () => {
  if (!("Notification" in window)) return updateNotifStatus();
  await Notification.requestPermission();
  updateNotifStatus();
});
$("#btnTest").addEventListener("click", async () => {
  if (Notification.permission !== "granted") return alert("請先開啟通知");
  const t = sortedTasks(Date.now(), "prio").find((x) => !x.done);
  await showNotification("作業快截止了", t ? `${t.course}：${t.title}（${relTime(t.due - Date.now())}）` : "測試通知", "test", t ? `./?view=tasks&task=${encodeURIComponent(t.id)}` : "./");
});
$("#btnBrief").addEventListener("click", async () => {
  if (Notification.permission !== "granted") return alert("請先開啟通知");
  const b = buildBrief(Date.now());
  await showNotification(b.title, b.body, "brief-test", "./");
});

// ---------- 前景檢查提醒（App 開著時的備援；背景推播由後端 Web Push 負責） ----------
function checkReminders() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const s = loadSettings();
  const leads = s.leads || [1440, 180];
  const classLead = s.classLead || 30;
  const now = Date.now();

  // 清掉兩週前的已發送記錄
  for (const k of Object.keys(state.fired)) if (now - state.fired[k] > 14 * DAY) delete state.fired[k];

  const fire = (key, title, body, url) => {
    if (state.fired[key]) return;
    state.fired[key] = now;
    saveState();
    showNotification(title, body, key, url);
  };

  for (const t of DATA.tasks) {
    if (t.done) continue;
    const link = `./?view=tasks&task=${encodeURIComponent(t.id)}`;
    const snoozeUntil = state.snooze[t.id];

    // 貪睡到期：再提醒一次
    if (snoozeUntil && snoozeUntil <= now) {
      delete state.snooze[t.id];
      saveState();
      if (t.due > now) fire(`snooze-${t.id}-${snoozeUntil}`, "作業再提醒", `${t.course}：${t.title}（${relTime(t.due - now)}）`, link);
      continue;
    }
    if (snoozeUntil && snoozeUntil > now) continue; // 貪睡中不發一般提醒

    const left = t.due - now;
    if (left <= 0) continue;
    // 已錯過的提前提醒只補送最接近截止的那一則
    const hit = leads.filter((l) => left <= l * 60000).sort((a, b) => a - b)[0];
    if (hit !== undefined) fire(`task-${t.id}-${hit}`, "作業截止提醒", `${t.course}：${t.title}（${relTime(left)}）`, link);
  }

  const c = nextClass(DATA.schedule, new Date(now));
  if (c && c.startAt > now && c.startAt - now <= classLead * 60000) {
    fire(`class-${c.course}-${c.startAt.getTime()}`, "快上課了", `${c.course}　📍${c.room}（${relTime(c.startAt - now)}）`, "./");
  }

  // 每日總覽：到達設定時間後 3 小時內，每天只發一次
  if (s.briefOn !== false) {
    const [bh, bm] = (s.briefTime || "07:30").split(":").map(Number);
    const at = new Date(now); at.setHours(bh, bm, 0, 0);
    if (now >= at.getTime() && now - at.getTime() <= 3 * HOUR && state.briefDate !== dateKey(now)) {
      state.briefDate = dateKey(now);
      saveState();
      const b = buildBrief(now);
      showNotification(b.title, b.body, "brief-" + dateKey(now), "./");
    }
  }
}

// ---------- 啟動 ----------
(async function init() {
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("sw.js"); } catch (e) { console.warn("SW 註冊失敗", e); }
  }
  RAW = await loadData();
  applySettings();
  rebuild();
  updateNotifStatus();
  render();

  // 從通知點進來：?view=tasks&task=ID
  const q = new URLSearchParams(location.search);
  if (q.get("view")) switchView(q.get("view"));
  if (q.get("task")) {
    const el = document.querySelector(`#tasks [data-id="${CSS.escape(q.get("task"))}"]`);
    if (el) { el.classList.add("flash"); el.scrollIntoView({ block: "center" }); }
  }

  checkReminders();
  setInterval(() => { render(); checkReminders(); }, 60 * 1000);
})();
