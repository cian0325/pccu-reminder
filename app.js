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

// ---------- 資料來源 ----------
// 優先順序：後端 API（第二階段）> 我手動輸入的資料 > 示範資料（虛構）
const MINE_KEY = "pccu-reminder-mine";
const MODE_KEY = "pccu-reminder-mode";

function loadMine() {
  try {
    const m = JSON.parse(localStorage.getItem(MINE_KEY));
    if (m) return { schedule: m.schedule || [], tasks: m.tasks || [], notices: m.notices || [] };
  } catch { /* ignore */ }
  return { schedule: [], tasks: [], notices: [] };
}
function saveMine(m) { try { localStorage.setItem(MINE_KEY, JSON.stringify(m)); } catch { /* ignore */ } }
function hasMine() { const m = loadMine(); return m.schedule.length + m.tasks.length + m.notices.length > 0; }
function getMode() {
  try { const v = localStorage.getItem(MODE_KEY); if (v === "mine" || v === "demo") return v; } catch { /* ignore */ }
  return hasMine() ? "mine" : "demo";
}
function setMode(v) { try { localStorage.setItem(MODE_KEY, v); } catch { /* ignore */ } }
const uid = () => "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function loadData() {
  try {
    if (window.API_BASE) {
      const r = await fetch(window.API_BASE + "/api/summary", { credentials: "include" });
      if (r.ok) return await r.json();
    }
  } catch (e) { /* fall through */ }
  if (getMode() === "mine") return { ...loadMine(), source: "manual" };
  return window.DEMO_DATA;
}

async function reloadData() {
  RAW = await loadData();
  applySettings();
  rebuild();
  render();
  renderMine();
}

let RAW = null;
let DATA = null;
function rebuild() {
  DATA = mergeLocal(filterSemester(RAW, activeSemester()));
}

// ---------- 學校行事曆 ----------
const CAL_TYPES = {
  holiday: { icon: "🏖️", label: "放假" },
  exam: { icon: "📝", label: "考試" },
  course: { icon: "🗂️", label: "選課・註冊" },
  term: { icon: "🎓", label: "學期" },
  makeup: { icon: "🔁", label: "補課・調整" },
  deadline: { icon: "⏳", label: "截止" },
  other: { icon: "📌", label: "其他" }
};

function ymd(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function ymdToDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function calendar() {
  return window.SCHOOL_CALENDAR || { loaded: false, semesters: {}, events: [] };
}
function calEvents() {
  return (calendar().events || []).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.start || ""))
    .map((e, i) => ({ ...e, id: e.id || `e${i}`, end: e.end || e.start, type: CAL_TYPES[e.type] ? e.type : "other" }))
    .sort((x, y) => x.start.localeCompare(y.start) || x.end.localeCompare(y.end));
}
// 某天（YYYY-MM-DD）涵蓋的事件
function eventsOn(day) {
  return calEvents().filter((e) => e.start <= day && day <= e.end);
}
// 這天是否停課；回傳造成停課的事件或 null
function noClassReason(day) {
  return eventsOn(day).find((e) => e.noClass) || null;
}
// 這天在學期上課期間內嗎？行事曆沒提供學期期間時一律視為在期間內
function inTerm(day) {
  const sems = Object.values(calendar().semesters || {});
  if (!sems.length) return true;
  return sems.some((s) => s.start <= day && day <= s.end);
}
// 這天實際要上星期幾的課（補課日會改上別天的課）；停課回傳 null
function effectiveWeekday(date) {
  const day = ymd(date);
  if (!inTerm(day) || noClassReason(day)) return null;
  const mk = eventsOn(day).find((e) => Number.isInteger(e.followsWeekday));
  return mk ? mk.followsWeekday : date.getDay();
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
    const wd = effectiveWeekday(day);
    if (wd === null) continue;
    for (const s of schedule) {
      if (s.weekday === wd) {
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
  const wdToday = effectiveWeekday(d);
  const off = noClassReason(ymd(now));
  const todays = wdToday === null ? [] : DATA.schedule.filter((s) => s.weekday === wdToday).sort((a, b) => a.start.localeCompare(b.start));
  const calToday = eventsOn(ymd(now)).filter((e) => !e.scope);
  const calTomorrow = eventsOn(ymd(now + DAY)).filter((e) => !e.scope && e.start === ymd(now + DAY));
  const dueSoon = DATA.tasks.filter((t) => !t.done && t.due > now && t.due - now <= DAY).sort((a, b) => a.due - b.due);
  const overdue = DATA.tasks.filter((t) => !t.done && t.due <= now);
  const unread = DATA.notices.filter((n) => !n.read).length;

  const lines = [];
  if (todays.length) lines.push(`🎓 今天 ${todays.length} 堂課：` + todays.map((s) => `${s.start} ${s.course}（${roomText(s.room)}）`).join("、"));
  else lines.push(off ? `🎓 今天停課（${off.title}）` : "🎓 今天沒有課");
  if (calToday.length) lines.push("📅 今天：" + calToday.map((e) => e.title).join("、"));
  if (calTomorrow.length) lines.push("📅 明天：" + calTomorrow.map((e) => e.title).join("、"));
  if (dueSoon.length) lines.push(`⏰ 24 小時內截止 ${dueSoon.length} 份：` + dueSoon.map((t) => t.title).join("、"));
  else lines.push("⏰ 24 小時內沒有作業截止");
  if (overdue.length) lines.push(`⚠️ 已逾期未完成 ${overdue.length} 份`);
  if (unread) lines.push(`📢 未讀公告 ${unread} 則`);

  let body = todays.length ? `今天 ${todays.length} 堂課，第一堂 ${todays[0].start} ${todays[0].course}（${roomText(todays[0].room)}）。`
    : off ? `今天停課（${off.title}）。` : "今天沒有課。";
  if (calTomorrow.length) body += `明天：${calTomorrow.map((e) => e.title).join("、")}。`;
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

// 有些課（例如體育）頁面上沒有教室
const roomText = (r) => r || "教室未標示";

function mapUrl(room) {
  const building = String(room).split(/\s+/)[0];
  return "https://maps.apple.com/?q=" + encodeURIComponent("中國文化大學 " + building);
}

function renderNextClass(now) {
  const el = $("#nextClass");
  const c = nextClass(DATA.schedule, new Date(now));
  const off = noClassReason(ymd(now));
  const offLine = off ? `<div class="meta off">🏖️ 今天停課：${esc(off.title)}</div>` : "";
  if (!c) { el.innerHTML = `<div class="label">下一堂課</div><div class="name">近期沒有課程</div>${offLine}`; return; }
  const ongoing = c.startAt <= now;
  el.innerHTML = `${offLine}<div class="label">${ongoing ? "正在上課" : "下一堂課"}</div>
    <div class="name">${esc(c.course)}</div>
    <div class="meta">📍 ${esc(roomText(c.room))}　🕘 ${fmtDate(c.startAt)} – ${c.end}</div>
    <div class="meta">${ongoing ? "進行中" : relTime(c.startAt - now) + "開始"}・${esc(c.teacher || "")}</div>
    ${c.room ? `<a class="btn secondary small" id="navLink" href="${mapUrl(c.room)}" target="_blank" rel="noopener">🧭 導航到教室</a>` : ""}`;
}

function renderSchedule(now) {
  const today = new Date(now).getDay();
  const ws = weekStart(now);
  const dateOfWd = (wd) => ymd(ws + ((wd + 6) % 7) * DAY);
  const days = [1, 2, 3, 4, 5];
  if (DATA.schedule.some((s) => s.weekday === 6)) days.push(6);
  if (DATA.schedule.some((s) => s.weekday === 0)) days.push(0);
  $("#schedule").innerHTML = days.map((wd) => {
    const slots = DATA.schedule.filter((s) => s.weekday === wd).sort((a, b) => a.start.localeCompare(b.start));
    const body = slots.length
      ? slots.map((s) => `<div class="slot"><div class="time">${s.start}–${s.end}</div>
          <div><div>${esc(s.course)}</div><div class="room">${esc(roomText(s.room))}</div></div></div>`).join("")
      : '<div class="muted">沒有課</div>';
    const dk = dateOfWd(wd);
    const off = noClassReason(dk);
    const mk = eventsOn(dk).find((e) => Number.isInteger(e.followsWeekday));
    const md = dk.slice(5).replace("-", "/").replace(/^0/, "");
    const note = off ? `<div class="day-note off">🏖️ 停課：${esc(off.title)}</div>`
      : mk ? `<div class="day-note">🔁 ${esc(mk.title)}</div>` : "";
    return `<div class="day ${wd === today ? "today" : ""}${off ? " is-off" : ""}"><h3>${WEEKDAY_NAMES[wd]} <span class="muted-inline">${md}</span>${wd === today ? "（今天）" : ""}</h3>${note}${body}</div>`;
  }).join("");
}

function calItem(e, now) {
  const t = CAL_TYPES[e.type];
  const s = ymdToDate(e.start), en = ymdToDate(e.end);
  const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}（${WEEKDAY_NAMES[d.getDay()].slice(1)}）`;
  const range = e.start === e.end ? fmt(s) : `${fmt(s)} – ${fmt(en)}`;
  const today = ymd(now);
  const days = Math.round((s - ymdToDate(today)) / DAY);
  const when = e.start === today && e.end === today ? "今天" : e.start <= today && today <= e.end ? "進行中"
    : days === 1 ? "明天" : days > 0 ? `${days} 天後` : "";
  const tags = [e.noClass ? '<span class="tag urgent">停課</span>' : "",
    e.scope ? `<span class="tag done">${esc(e.scope)}</span>` : "", Number.isInteger(e.followsWeekday) ? `<span class="tag soon">上${WEEKDAY_NAMES[e.followsWeekday]}的課</span>` : ""].join("");
  return `<li class="cal cal-${e.type}${e.end < today ? " past" : ""}"><div class="title">${t.icon} ${esc(e.title)}${tags}</div>
    <div class="sub">${range}${when ? "・" + when : ""}・${t.label}${e.derived ? "・依附註整理" : ""}</div></li>`;
}

function renderCalendar(now) {
  const cal = calendar();
  const today = ymd(now);
  const filter = state.calFilter || "all";
  let list = calEvents().filter((e) => filter === "all" || e.type === filter || (filter === "noClass" && e.noClass));
  if (!state.calShowPast) list = list.filter((e) => e.end >= today);

  $("#calStatus").innerHTML = cal.loaded
    ? `資料來源：<a href="${esc(cal.sourceUrl)}" target="_blank" rel="noopener">${esc(cal.source)}</a>，以學校公告為準。`
    : "尚未載入學校行事曆。";
  document.querySelectorAll("#calFilter button").forEach((b) => b.classList.toggle("on", b.dataset.f === filter));
  $("#calPast").checked = !!state.calShowPast;

  if (!list.length) { $("#calList").innerHTML = `<li class="muted">${cal.loaded ? "沒有符合的事件" : "尚未載入行事曆"}</li>`; return; }
  let html = "", month = "";
  for (const e of list) {
    const m = e.start.slice(0, 7);
    if (m !== month) { month = m; const [y, mm] = m.split("-"); html += `<li class="cal-month">${y} 年 ${Number(mm)} 月</li>`; }
    html += calItem(e, now);
  }
  $("#calList").innerHTML = html;
}

function renderHomeCalendar(now) {
  const today = ymd(now), until = ymd(now + 30 * DAY);
  const soon = calEvents().filter((e) => !e.scope && e.end >= today && e.start <= until).slice(0, 3);
  $("#homeCal").innerHTML = soon.map((e) => calItem(e, now)).join("") ||
    `<li class="muted">${calendar().loaded ? "30 天內沒有行事曆事件" : "尚未載入學校行事曆"}</li>`;
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
  $("#homeNotices").innerHTML = notices.slice(0, 3).map(noticeItem).join("") || '<li class="muted">沒有公告</li>';
  $("#demoBanner").hidden = DATA.source !== "demo";
  renderStats(now);
  renderSchedule(now);
  renderCalendar(now);
  renderHomeCalendar(now);
  $("#tasks").innerHTML = sortedTasks(now, state.sort).map((t) => taskItem(t, now, true)).join("") || '<li class="muted">這個學期沒有作業</li>';
  document.querySelectorAll("#sortSeg button").forEach((b) => b.classList.toggle("on", b.dataset.sort === state.sort));
  $("#notices").innerHTML = notices.map(noticeItem).join("");
  const srcName = { demo: "示範資料（虛構，非真實課程）", manual: "我手動輸入的資料" }[DATA.source] || "課輔系統（後端同步）";
  $("#dataSource").textContent = "目前資料來源：" + srcName;
  $("#clock").textContent = activeSemester() + "・" + new Date(now).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
}

// ---------- 導覽 ----------
function switchView(name) {
  if (name === "mine") renderMine();
  document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("active", x.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  window.scrollTo(0, 0);
}
document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));

function showSchedPane(pane) {
  document.querySelectorAll("#schedSeg button").forEach((b) => b.classList.toggle("on", b.dataset.pane === pane));
  $("#paneWeek").hidden = pane !== "week";
  $("#paneCal").hidden = pane !== "cal";
}
$("#calPast").addEventListener("change", () => { state.calShowPast = $("#calPast").checked; saveState(); renderCalendar(Date.now()); });
$("#btnHomeCal").addEventListener("click", () => { switchView("schedule"); showSchedPane("cal"); });

// ---------- 作業互動（事件委派） ----------
document.addEventListener("click", (e) => {
  const schedBtn = e.target.closest("#schedSeg button");
  if (schedBtn) { showSchedPane(schedBtn.dataset.pane); return; }
  const calBtn = e.target.closest("#calFilter button");
  if (calBtn) { state.calFilter = calBtn.dataset.f; saveState(); renderCalendar(Date.now()); return; }

  const sortBtn = e.target.closest("#sortSeg button");
  if (sortBtn) { state.sort = sortBtn.dataset.sort; saveState(); render(); return; }

  const del = e.target.closest("[data-delbtn]");
  if (del) {
    const li = del.closest("[data-del]");
    const [type, id] = li.dataset.del.split(":");
    const m = loadMine();
    m[type] = m[type].filter((x) => x.id !== id);
    saveMine(m);
    reloadData();
    return;
  }

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

// ---------- 手動輸入我的資料 ----------
function renderMine() {
  const m = loadMine();
  $("#modeSel").value = getMode();
  $("#courseList").innerHTML = [...new Set(m.schedule.map((s) => s.course))].map((c) => `<option value="${esc(c)}">`).join("");
  const rows = [
    ...m.schedule.map((s) => `<li data-del="schedule:${esc(s.id)}"><div class="title">🎓 ${esc(s.course)}</div>
      <div class="sub">${esc(s.semester)}・${WEEKDAY_NAMES[s.weekday]} ${esc(s.start)}–${esc(s.end)}・${esc(s.room)}</div>
      <div class="actions"><button data-delbtn>刪除</button></div></li>`),
    ...m.tasks.map((t) => `<li data-del="tasks:${esc(t.id)}"><div class="title">📝 ${esc(t.title)}</div>
      <div class="sub">${esc(t.semester)}・${esc(t.course)}・截止 ${fmtDate(t.due)}</div>
      <div class="actions"><button data-delbtn>刪除</button></div></li>`)
  ];
  $("#mineList").innerHTML = rows.join("") || '<li class="muted">還沒有資料。先新增課程與作業吧。</li>';
}

$("#formCourse").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  if (f.end.value <= f.start.value) return alert("下課時間必須晚於上課時間");
  const m = loadMine();
  m.schedule.push({
    id: uid(), semester: activeSemester(), weekday: Number(f.weekday.value),
    start: f.start.value, end: f.end.value,
    course: f.course.value.trim(), room: f.room.value.trim(), teacher: f.teacher.value.trim()
  });
  saveMine(m);
  setMode("mine");
  ev.target.reset();
  reloadData();
});

$("#formTask").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = ev.target.elements;
  const due = new Date(f.due.value).getTime();
  if (Number.isNaN(due)) return alert("請選擇截止時間");
  const m = loadMine();
  m.tasks.push({ id: uid(), semester: activeSemester(), course: f.course.value.trim(), title: f.title.value.trim(), due, done: false });
  saveMine(m);
  setMode("mine");
  ev.target.reset();
  reloadData();
});

// ---------- 匯入（pccu_parser 產生的 JSON） ----------
const HM = /^\d{1,2}:\d{2}$/;

function toMillis(v) {
  if (typeof v === "number") return v;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ""));
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], 12, 0).getTime(); // 公告只有日期，取中午避免時區換日
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

// 回傳 { schedule, notices, tasks } 筆數；格式錯誤時丟出 Error
function importMine(jsonText) {
  let data;
  try { data = JSON.parse(jsonText); } catch { throw new Error("不是有效的 JSON，請確認完整貼上。"); }
  const sem = activeSemester();
  const schedule = (data.schedule || []).map((s, i) => {
    if (!HM.test(s.start) || !HM.test(s.end) || !(s.weekday >= 0 && s.weekday <= 6) || !s.course)
      throw new Error(`課表第 ${i + 1} 筆格式不正確`);
    return { id: String(s.id || uid()), semester: s.semester || sem, weekday: s.weekday, start: s.start, end: s.end,
      course: String(s.course), room: String(s.room || ""), teacher: String(s.teacher || "") };
  });
  const notices = (data.notices || []).map((n, i) => {
    const posted = toMillis(n.posted ?? n.postedDate);
    if (!n.title || posted === null) throw new Error(`公告第 ${i + 1} 筆格式不正確`);
    return { id: String(n.id || uid()), semester: n.semester || sem, course: String(n.course || ""), title: String(n.title), posted, read: !!n.read };
  });
  const tasks = (data.tasks || []).map((t, i) => {
    const due = toMillis(t.due);
    if (!t.title || due === null) throw new Error(`作業第 ${i + 1} 筆格式不正確`);
    return { id: String(t.id || uid()), semester: t.semester || sem, course: String(t.course || ""), title: String(t.title), due, done: !!t.done };
  });
  if (!schedule.length && !notices.length && !tasks.length) throw new Error("沒有可匯入的內容。");

  const m = loadMine();
  // 課表與公告：取代「匯入檔中出現的學期」的舊資料；作業：只新增、依標題＋課程＋截止時間去重
  const semsS = new Set(schedule.map((x) => x.semester));
  const semsN = new Set(notices.map((x) => x.semester));
  m.schedule = m.schedule.filter((x) => !semsS.has(x.semester)).concat(schedule);
  m.notices = m.notices.filter((x) => !semsN.has(x.semester)).concat(notices);
  const key = (t) => `${t.course}|${t.title}|${t.due}`;
  const have = new Set(m.tasks.map(key));
  const added = tasks.filter((t) => !have.has(key(t)));
  m.tasks = m.tasks.concat(added);
  saveMine(m);
  setMode("mine");
  return { schedule: schedule.length, notices: notices.length, tasks: added.length };
}

async function doImport(text) {
  try {
    const r = importMine(text);
    $("#importText").value = "";
    await reloadData();
    alert(`已匯入 ${r.schedule} 個上課時段、${r.notices} 則公告、${r.tasks} 份作業`);
  } catch (e) {
    alert(e.message);
  }
}
$("#btnImport").addEventListener("click", () => doImport($("#importText").value));
$("#importFile").addEventListener("change", async (ev) => {
  const f = ev.target.files && ev.target.files[0];
  if (f) doImport(await f.text());
  ev.target.value = "";
});

$("#modeSel").addEventListener("change", () => { setMode($("#modeSel").value); reloadData(); });
$("#btnMine").addEventListener("click", () => switchView("mine"));
$("#btnBannerMine").addEventListener("click", () => switchView("mine"));

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
      briefTime: $("#briefTime").value || "07:30",
      calOn: $("#calOn").checked
    }));
  } catch { /* ignore */ }
}
function applySettings() {
  const s = loadSettings();
  if (s.leads) document.querySelectorAll("[data-lead]").forEach((c) => (c.checked = s.leads.includes(Number(c.dataset.lead))));
  if (s.classLead) $("#classLead").value = s.classLead;
  $("#briefOn").checked = s.briefOn !== false;
  $("#briefTime").value = s.briefTime || "07:30";
  $("#calOn").checked = s.calOn !== false;
  fillSemesterSelect(s.semester || "auto");
}

function fillSemesterSelect(selected) {
  const list = RAW.semesters || [...new Set([...RAW.schedule, ...RAW.tasks, ...RAW.notices].map((x) => x.semester).filter(Boolean))].sort().reverse();
  const opts = [`<option value="auto">自動（目前學期 ${currentSemester()}）</option>`].concat(list.map((x) => `<option value="${x}">${x}</option>`));
  $("#semesterSel").innerHTML = opts.join("");
  $("#semesterSel").value = selected;
}

$("#semesterSel").addEventListener("change", () => { saveSettings(); rebuild(); render(); });
document.querySelectorAll("[data-lead], #classLead, #briefOn, #briefTime, #calOn").forEach((el) => el.addEventListener("change", saveSettings));

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
    fire(`class-${c.course}-${c.startAt.getTime()}`, "快上課了", `${c.course}　📍${roomText(c.room)}（${relTime(c.startAt - now)}）`, "./");
  }

  // 行事曆：考試、選課、截止、停課、補課 → 前一天 19:00 後提醒一次，當天開啟 App 也會補發
  if (s.calOn !== false) {
    const today = ymd(now), tomorrow = ymd(now + DAY);
    const hour = new Date(now).getHours();
    const important = (e) => !e.scope && (e.noClass || ["exam", "course", "deadline", "makeup"].includes(e.type));
    for (const e of calEvents()) {
      if (!important(e)) continue;
      const isTomorrow = e.start === tomorrow && hour >= 19;
      const isToday = e.start === today;
      if (!isTomorrow && !isToday) continue;
      const when = isToday ? "今天" : "明天";
      const extra = e.noClass ? "（停課）" : Number.isInteger(e.followsWeekday) ? `（上${WEEKDAY_NAMES[e.followsWeekday]}的課）` : "";
      fire(`cal-${e.start}-${e.title}`, `行事曆：${when}${CAL_TYPES[e.type].label}`, `${e.title}${extra}`, "./?view=schedule&pane=cal");
    }
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
  if (q.get("pane")) showSchedPane(q.get("pane"));
  if (q.get("task")) {
    const el = document.querySelector(`#tasks [data-id="${CSS.escape(q.get("task"))}"]`);
    if (el) { el.classList.add("flash"); el.scrollIntoView({ block: "center" }); }
  }

  checkReminders();
  setInterval(() => { render(); checkReminders(); }, 60 * 1000);
})();
