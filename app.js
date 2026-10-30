"use strict";

const WEEKDAY_NAMES = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];
// 在 Claude 網頁（Artifact）裡執行時，資料由 Claude 爬蟲後直接寫進雲端資料庫，App 自動更新
const IN_CLAUDE = !!(window.claude && typeof window.claude.use === "function");

// 本機儲存：先存在記憶體，再盡量寫進 localStorage。
// 有些環境（私密瀏覽、部分 Claude 檢視器）localStorage 會丟錯或讀不到；這時 App 仍要能用這次開啟期間的資料。
const MEM = {};
const kv = {
  get(k) {
    if (Object.prototype.hasOwnProperty.call(MEM, k)) return MEM[k];
    try { const v = localStorage.getItem(k); MEM[k] = v; return v; } catch { return null; }
  },
  set(k, v) {
    MEM[k] = v;
    try { localStorage.setItem(k, v); } catch { /* 只留在記憶體 */ }
  }
};
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

// ---------- 頁內提示 ----------
let toastTimer = null;
function toast(msg, ms = 4000) {
  const el = $("#toast");
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

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
const emptyState = () => ({ done: {}, snooze: {}, star: {}, progress: {}, fired: {}, read: {}, briefDate: "", sort: "prio" });
let state = loadState();

function loadState() {
  try { return Object.assign(emptyState(), JSON.parse(kv.get(STATE_KEY)) || {}); } catch { return emptyState(); }
}
function saveState() {
  try { kv.set(STATE_KEY, JSON.stringify(state)); } catch { /* 私密瀏覽等情況 */ }
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
    })),
    notices: data.notices.map((n) => ({ ...n, read: !!n.read || !!state.read[n.id] }))
  };
}

// ---------- 資料來源 ----------
// 優先順序：後端 API（第二階段）> 我手動輸入的資料 > 示範資料（虛構）
const MINE_KEY = "pccu-reminder-mine";
const MODE_KEY = "pccu-reminder-mode";

function loadMine() {
  try {
    const m = JSON.parse(kv.get(MINE_KEY));
    if (m) return { schedule: m.schedule || [], tasks: m.tasks || [], notices: m.notices || [], meta: m.meta || {} };
  } catch { /* ignore */ }
  return { schedule: [], tasks: [], notices: [], meta: {} };
}
function saveMine(m) { try { kv.set(MINE_KEY, JSON.stringify(m)); } catch { /* ignore */ } }
function hasMine() { const m = loadMine(); return m.schedule.length + m.tasks.length + m.notices.length > 0; }
function getMode() {
  try { const v = kv.get(MODE_KEY); if (v === "mine" || v === "demo") return v; } catch { /* ignore */ }
  return hasMine() || IN_CLAUDE ? "mine" : "demo";
}
function setMode(v) { try { kv.set(MODE_KEY, v); } catch { /* ignore */ } }
const uid = () => "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function loadData() {
  try {
    if (window.API_BASE) {
      const r = await fetch(window.API_BASE + "/api/summary", { credentials: "include" });
      if (r.ok) return await r.json();
    }
  } catch (e) { /* fall through */ }
  // Claude 網頁版第一次打開、手機上還沒有任何資料：等雲端資料，不顯示示範資料
  if (IN_CLAUDE && !hasMine()) return { schedule: [], tasks: [], notices: [], source: "cloud-wait" };
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
      <span class="ttl" data-open="${esc(t.id)}" role="button" tabindex="0">${esc(t.title)}${t.star ? " ⭐" : ""}</span>${dueTag(t, now)}</div>
    <div class="sub" data-open="${esc(t.id)}">${esc(t.course)}・${fmtDate(t.due)}${t.dueConfidence === "range" ? "（推測）" : ""}・${t.done ? "已繳交" : relTime(t.due - now)}${t.done ? "" : `・優先度 ${lv.label}`}</div>
    ${t.detail ? `<div class="preview" data-open="${esc(t.id)}">📄 ${esc(t.detail.replace(/\s+/g, " ").slice(0, 50))}${t.detail.length > 50 ? "…" : ""}</div>` : ""}
    ${t.source === "crawler" ? `<div class="sub src">🤖 自動抓取${t.dueConfidence === "range" ? "・截止時間是從日期範圍推測的，請到課輔系統確認" : ""}${t.url ? `・<a href="${esc(t.url)}" target="_blank" rel="noopener">在課輔系統開啟</a>` : ""}</div>` : ""}`;
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
  return `<li class="notice ${n.read ? "" : "unread"}" data-notice="${esc(n.id)}" role="button" tabindex="0">
    <div class="title">${esc(n.title)}</div>
    <div class="sub">${esc(n.course)}・${fmtDate(n.posted).replace(/ \d{2}:\d{2}$/, "").replace(/）\d{2}:\d{2}$/, "）")}${n.content ? "" : "・尚無內文"}</div>
    ${n.content ? `<div class="preview">${esc(n.content.replace(/\s+/g, " ").slice(0, 60))}${n.content.length > 60 ? "…" : ""}</div>` : ""}</li>`;
}

// 內文只當純文字顯示（不執行學校頁面的 HTML），網址自動變成連結
function linkify(text) {
  return esc(text).replace(/https?:\/\/[^\s<>"'）)】]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`).replace(/\n/g, "<br>");
}

function openNotice(id) {
  const n = DATA.notices.find((x) => x.id === id);
  if (!n) return;
  if (!n.read) { state.read[id] = Date.now(); saveState(); rebuild(); render(); }
  $("#sheetBody").innerHTML = `<div class="label">${esc(n.course)}</div>
    <h3 class="sheet-title">${esc(n.title)}</h3>
    <div class="sub">${fmtDate(n.posted).replace(/）\d{2}:\d{2}$/, "）")}${n.teacher ? `・${esc(n.teacher)}` : ""}</div>
    <div class="notice-content">${n.content ? linkify(n.content)
      : '<p class="muted">這則公告還沒有內文。內文需要由電腦上的爬蟲抓取（見 README），或到課輔系統查看。</p>'}</div>
    ${n.links && n.links.length ? `<div class="label">附件與連結</div><ul class="links">${n.links.map((l) => `<li><a href="${esc(l.href)}" target="_blank" rel="noopener">📎 ${esc(l.text || l.href)}</a></li>`).join("")}</ul>` : ""}
    ${n.url ? `<a class="btn secondary small" href="${esc(n.url)}" target="_blank" rel="noopener">在課輔系統開啟</a>` : ""}`;
  $("#sheet").hidden = false;
  document.body.classList.add("sheet-open");
  $("#sheetClose").focus();
}
// 作業詳細：課輔系統上的作業內容要求
function openTask(id) {
  const t = DATA.tasks.find((x) => x.id === id);
  if (!t) return;
  const now = Date.now();
  $("#sheetBody").innerHTML = `<div class="label">${esc(t.course)}</div>
    <h3 class="sheet-title">${esc(t.title)}</h3>
    <div class="sub">截止 ${fmtDate(t.due)}${t.dueConfidence === "range" ? "（推測）" : ""}・${t.done ? "已繳交" : relTime(t.due - now)}</div>
    <div class="label">作業要求</div>
    <div class="notice-content">${t.detail ? linkify(t.detail)
      : `<p class="muted">${t.source === "crawler" ? "課輔系統上這份作業沒有文字說明，可能放在附件裡。" : "這是你手動新增的作業，沒有說明。"}</p>`}</div>
    ${t.prog && t.prog.note ? `<div class="note">📝 ${esc(t.prog.note)}</div>` : ""}
    <div class="actions">
      ${t.url ? `<a class="btn secondary small" href="${esc(t.url)}" target="_blank" rel="noopener">在課輔系統開啟（附件、繳交）</a>` : ""}
      ${t.done ? "" : `<button class="btn secondary small" type="button" data-sheet-note="${esc(t.id)}">備註</button>`}
    </div>`;
  $("#sheet").hidden = false;
  document.body.classList.add("sheet-open");
  $("#sheetClose").focus();
}
function openNoteEditor(t) {
  const p = state.progress[t.id] || { stage: 0, note: "" };
  $("#sheetBody").innerHTML = `<div class="label">${esc(t.course)}</div>
    <h3 class="sheet-title">${esc(t.title)}</h3>
    <form class="form" id="noteForm">
      <label for="noteText" class="muted">備註（例如：卡在 operator&lt;&lt; 的 friend 宣告）</label>
      <textarea id="noteText" rows="4" maxlength="200"></textarea>
      <button class="btn" type="submit">儲存備註</button>
    </form>`;
  $("#noteText").value = p.note || "";
  $("#noteForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    p.note = $("#noteText").value.trim().slice(0, 200);
    state.progress[t.id] = p;
    saveState();
    closeSheet();
    rebuild();
    render();
    toast(p.note ? "備註已儲存" : "備註已清除");
  });
  $("#sheet").hidden = false;
  document.body.classList.add("sheet-open");
  $("#noteText").focus();
}

function closeSheet() {
  $("#sheet").hidden = true;
  document.body.classList.remove("sheet-open");
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

function renderSync(now) {
  const meta = (getMode() === "mine" && loadMine().meta) || {};
  const el = $("#syncStatus");
  if (!meta.lastSync) { el.innerHTML = ""; $("#syncBanner").hidden = true; return; }
  const t = new Date(meta.lastSync).getTime();
  const ageH = (now - t) / HOUR;
  const stale = ageH > 36;
  el.innerHTML = `<p class="muted">🤖 上次爬蟲同步：${fmtDate(t)}${stale ? `　<b class="warn">已超過 ${Math.floor(ageH / 24)} 天，作業可能不是最新的</b>` : ""}</p>` +
    (meta.report && meta.report.length ? `<details><summary>爬蟲訊息（${meta.report.length}）</summary><ul class="report">${meta.report.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></details>` : "");
  $("#syncBanner").hidden = !stale;
  $("#syncBanner").textContent = `作業資料是 ${Math.floor(ageH / 24)} 天前同步的，請在電腦上重新執行爬蟲並匯入。`;
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
  const srcName = { demo: "示範資料（虛構，非真實課程）", manual: IN_CLAUDE ? "課輔系統（由 Claude 爬蟲同步）" : "我手動輸入的資料",
    "cloud-wait": "等待雲端同步" }[DATA.source] || "課輔系統（後端同步）";
  $("#dataSource").textContent = "目前資料來源：" + srcName;
  $("#cloudStatus").hidden = !IN_CLAUDE;
  $("#cloudStatus").textContent = cloudText();
  $("#cloudBanner").hidden = !(IN_CLAUDE && (cloudState === "empty" || DATA.source === "cloud-wait"));
  $("#cloudBanner").textContent = cloudState === "empty" ? cloudText() : "正在從雲端載入你的課表、作業與公告…";
  renderSync(now);
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
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#sheet").hidden) closeSheet();
  if ((e.key === "Enter" || e.key === " ") && e.target.dataset && e.target.dataset.notice) { e.preventDefault(); openNotice(e.target.dataset.notice); }
  else if ((e.key === "Enter" || e.key === " ") && e.target.dataset && e.target.dataset.open) { e.preventDefault(); openTask(e.target.dataset.open); }
});
$("#calPast").addEventListener("change", () => { state.calShowPast = $("#calPast").checked; saveState(); renderCalendar(Date.now()); });
$("#btnHomeCal").addEventListener("click", () => { switchView("schedule"); showSchedPane("cal"); });

// ---------- 作業互動（事件委派） ----------
document.addEventListener("click", (e) => {
  const noticeEl = e.target.closest("[data-notice]");
  if (noticeEl && !e.target.closest("a")) { openNotice(noticeEl.dataset.notice); return; }
  if (e.target.closest("#sheetClose") || e.target.id === "sheet") { closeSheet(); return; }
  const sheetNote = e.target.closest("[data-sheet-note]");
  if (sheetNote) { const t = DATA.tasks.find((x) => x.id === sheetNote.dataset.sheetNote); if (t) openNoteEditor(t); return; }
  const taskEl = e.target.closest("[data-open]");
  if (taskEl && !e.target.closest("a, button")) { openTask(taskEl.dataset.open); return; }

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
    case "note":
      openNoteEditor(t);
      return;
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
  if (f.end.value <= f.start.value) return toast("下課時間必須晚於上課時間");
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
  if (Number.isNaN(due)) return toast("請選擇截止時間");
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
  const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : "");
  const notices = (data.notices || []).map((n, i) => {
    const posted = toMillis(n.posted ?? n.postedDate);
    if (!n.title || posted === null) throw new Error(`公告第 ${i + 1} 筆格式不正確`);
    return { id: String(n.id || uid()), semester: n.semester || sem, course: String(n.course || ""), title: String(n.title), posted, read: !!n.read,
      content: typeof n.content === "string" ? n.content.slice(0, 8000) : "",
      links: (Array.isArray(n.links) ? n.links : []).map((l) => ({ text: String(l.text || l.href || ""), href: safeUrl(l.href) })).filter((l) => l.href).slice(0, 20),
      url: safeUrl(n.url), teacher: typeof n.teacher === "string" ? n.teacher.slice(0, 40) : "" };
  });
  const tasks = (data.tasks || []).map((t, i) => {
    const due = toMillis(t.due);
    if (!t.title || due === null) throw new Error(`作業第 ${i + 1} 筆格式不正確`);
    return { id: String(t.id || uid()), semester: t.semester || sem, course: String(t.course || ""), title: String(t.title), due, done: !!t.done,
      source: t.source === "crawler" || data.source === "crawler" ? "crawler" : "manual",
      dueConfidence: t.dueConfidence === "range" ? "range" : t.dueConfidence === "labelled" ? "labelled" : "",
      url: safeUrl(t.url), detail: typeof t.detail === "string" ? t.detail.slice(0, 8000) : "" };
  });
  if (!schedule.length && !notices.length && !tasks.length && data.source !== "crawler") throw new Error("沒有可匯入的內容。");

  const m = loadMine();
  // 課表與公告：取代「匯入檔中出現的學期」的舊資料；作業：只新增、依標題＋課程＋截止時間去重
  const semsS = new Set(schedule.map((x) => x.semester));
  const semsN = new Set(notices.map((x) => x.semester));
  m.schedule = m.schedule.filter((x) => !semsS.has(x.semester)).concat(schedule);
  m.notices = m.notices.filter((x) => !semsN.has(x.semester)).concat(notices);
  let added;
  if (data.source === "crawler") {
    // 爬蟲每次都抓到「目前所有作業」：取代同學期先前爬到的作業，保留你手動新增的作業。
    // id 每次相同，所以你在 App 裡標的完成、重要、進度都會保留。
    const semsT = new Set([data.semester || sem, ...tasks.map((t) => t.semester)]);
    m.tasks = m.tasks.filter((t) => !(t.source === "crawler" && semsT.has(t.semester))).concat(tasks);
    added = tasks;
    m.meta = { ...(m.meta || {}), lastSync: data.generatedAt || new Date().toISOString(), report: Array.isArray(data.report) ? data.report.slice(0, 50).map(String) : [] };
  } else {
    const key = (t) => `${t.course}|${t.title}|${t.due}`;
    const have = new Set(m.tasks.map(key));
    added = tasks.filter((t) => !have.has(key(t)));
    m.tasks = m.tasks.concat(added);
  }
  saveMine(m);
  setMode("mine");
  return { schedule: schedule.length, notices: notices.length, tasks: added.length };
}

async function doImport(text) {
  try {
    const r = importMine(text);
    $("#importText").value = "";
    await reloadData();
    const rep = loadMine().meta?.report || [];
    toast(`已匯入 ${r.schedule} 個上課時段、${r.notices} 則公告、${r.tasks} 份作業` + (rep.length ? `。爬蟲有 ${rep.length} 則需要注意的訊息，可在「設定 → 資料來源」查看。` : ""), 6000);
  } catch (e) {
    toast(e.message, 6000);
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
  try { return JSON.parse(kv.get(SETTINGS_KEY)) || {}; } catch { return {}; }
}
function saveSettings() {
  const leads = [...document.querySelectorAll("[data-lead]")].filter((c) => c.checked).map((c) => Number(c.dataset.lead));
  try {
    kv.set(SETTINGS_KEY, JSON.stringify({
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

let resetArmed = 0;
$("#btnReset").addEventListener("click", () => {
  const b = $("#btnReset");
  if (Date.now() - resetArmed > 5000) {
    resetArmed = Date.now();
    b.textContent = "再按一次確認清除";
    setTimeout(() => { if (Date.now() - resetArmed >= 5000) b.textContent = "重設本機資料"; }, 5100);
    return;
  }
  resetArmed = 0;
  b.textContent = "重設本機資料";
  toast("已清除這支手機上的完成、進度、重要、備註與提醒記錄");
  state = emptyState();
  saveState();
  rebuild();
  render();
});

// ---------- 通知 ----------
const isStandalone = window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);

function canNotify() {
  return !IN_CLAUDE && "Notification" in window && Notification.permission === "granted";
}

function updateNotifStatus() {
  const el = $("#notifStatus");
  if (IN_CLAUDE) {
    el.textContent = "在 Claude 網頁裡無法發送手機系統通知；到了提醒時間，打開這個頁面時會在畫面上方提醒你。需要手機通知請改用加入主畫面的 App 版。";
    $("#btnNotif").hidden = true;
    $("#btnTest").hidden = true;
    $("#iosHint").hidden = true;
    return;
  }
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
  if (!("Notification" in window) || Notification.permission !== "granted") return toast("請先開啟通知");
  const t = sortedTasks(Date.now(), "prio").find((x) => !x.done);
  await showNotification("作業快截止了", t ? `${t.course}：${t.title}（${relTime(t.due - Date.now())}）` : "測試通知", "test", t ? `./?view=tasks&task=${encodeURIComponent(t.id)}` : "./");
});
$("#btnBrief").addEventListener("click", async () => {
  if (!("Notification" in window) || Notification.permission !== "granted") return toast(buildBrief(Date.now()).body, 8000);
  const b = buildBrief(Date.now());
  await showNotification(b.title, b.body, "brief-test", "./");
});

// ---------- 前景檢查提醒（App 開著時的備援；背景推播由後端 Web Push 負責） ----------
function checkReminders() {
  // 不能發系統通知時（例如在 Claude 網頁裡），改在畫面上提示；兩者都會記錄已提醒過，不重複
  if (!canNotify() && !IN_CLAUDE) return;
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
    if (canNotify()) showNotification(title, body, key, url);
    else pending.push(`${title}：${body}`);
  };
  const pending = [];

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
      if (canNotify()) showNotification(b.title, b.body, "brief-" + dateKey(now), "./");
      else pending.push(`${b.title}：${b.body}`);
    }
  }
  if (pending.length) toast(pending.slice(0, 3).join("\n"), 9000);
}

// ---------- 雲端同步（Claude 網頁版） ----------
// Claude 爬蟲後把結果寫進這個頁面的資料庫 sync/latest；頁面訂閱它，有新資料就自動匯入。
// 你在手機上標的完成、重要、進度、備註只存在這支手機，不會被同步覆蓋。
let cloudState = IN_CLAUDE ? "connecting" : "off";
async function startCloudSync() {
  if (!IN_CLAUDE) return;
  let db = null;
  try { db = await window.claude.use("db"); } catch { db = null; }
  if (!db) { cloudState = "unavailable"; render(); return; }
  cloudState = "waiting";
  db.doc("sync/latest").onSnapshot((snap) => {
    if (!snap.exists) { cloudState = "empty"; render(); return; }
    const data = snap.data() || {};
    cloudState = "ok";
    const applied = (loadMine().meta || {}).lastSync;
    if (data.generatedAt && data.generatedAt === applied) { render(); return; }
    try {
      const r = importMine(JSON.stringify(data));
      reloadData();
      toast(`已同步課輔系統：${r.tasks} 份作業、${r.notices} 則公告`);
    } catch (e) {
      toast("同步的資料格式有誤：" + e.message, 8000);
    }
  }, () => { cloudState = "unavailable"; render(); });
}

function cloudText() {
  return {
    connecting: "正在連線到雲端同步…",
    waiting: "正在讀取雲端同步的資料…",
    empty: "還沒有同步過。跟 Claude 說「幫我爬蟲」就會更新到這裡。",
    unavailable: "目前讀不到雲端同步的資料（請確認已登入 Claude）。仍可使用上次同步的內容。",
    ok: "已開啟自動同步：跟 Claude 說「幫我爬蟲」，這裡就會更新。"
  }[cloudState] || "";
}

// ---------- 啟動 ----------
(async function init() {
  if (!IN_CLAUDE && "serviceWorker" in navigator) {
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
  if (q.get("notice")) openNotice(q.get("notice"));
  if (q.get("task")) {
    const el = document.querySelector(`#tasks [data-id="${CSS.escape(q.get("task"))}"]`);
    if (el) { el.classList.add("flash"); el.scrollIntoView({ block: "center" }); }
  }

  checkReminders();
  setInterval(() => { render(); checkReminders(); }, 60 * 1000);
  startCloudSync();
})();
