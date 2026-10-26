// 示範資料（假資料）。串接後端後，改由 /api/summary 回傳相同格式。
// 每筆資料都帶 semester（學期，例如 "115-1"），前端與後端都只處理「目前學期」。
// 作業與公告的時間以「相對現在」產生，方便隨時展示。
(function () {
  const H = 3600 * 1000, D = 24 * H;
  const now = Date.now();

  window.DEMO_DATA = {
    source: "demo",
    schedule: [
      // weekday: 1=週一 … 5=週五
      { semester: "115-1", weekday: 1, start: "09:10", end: "12:00", course: "程式設計（C++）", room: "大典館 B101", teacher: "王老師" },
      { semester: "115-1", weekday: 2, start: "13:10", end: "15:00", course: "資料結構", room: "大孝館 305", teacher: "李老師" },
      { semester: "115-1", weekday: 3, start: "10:10", end: "12:00", course: "離散數學", room: "大忠館 202", teacher: "陳老師" },
      { semester: "115-1", weekday: 4, start: "09:10", end: "12:00", course: "程式設計（C++）實習", room: "大典館 電腦教室", teacher: "王老師" },
      { semester: "115-1", weekday: 5, start: "14:10", end: "16:00", course: "計算機概論", room: "大成館 401", teacher: "林老師" },
      // 舊學期資料：用來示範「不會被抓進來」
      { semester: "114-2", weekday: 1, start: "08:10", end: "10:00", course: "（舊學期）微積分", room: "大義館 101", teacher: "張老師" }
    ],
    tasks: [
      { semester: "115-1", id: "a1", course: "程式設計（C++）", title: "作業三：類別與運算子多載", due: now + 5 * H, done: false },
      { semester: "115-1", id: "a2", course: "資料結構", title: "實作鏈結串列（linked list）", due: now + 2 * D + 3 * H, done: false },
      { semester: "115-1", id: "a3", course: "離散數學", title: "習題 4.1–4.3", due: now + 6 * D, done: false },
      { semester: "115-1", id: "a4", course: "程式設計（C++）", title: "作業二：指標與動態記憶體", due: now - 3 * D, done: true, doneAt: now - 3 * D - 30 * H },
      { semester: "115-1", id: "a5", course: "資料結構", title: "習題一：陣列與複雜度", due: now - 1 * D, done: true, doneAt: now - 1 * D - 2 * H },
      { semester: "115-1", id: "a6", course: "計算機概論", title: "讀書心得", due: now - 5 * D, done: true, doneAt: now - 8 * D },
      { semester: "114-2", id: "o1", course: "（舊學期）微積分", title: "期末報告", due: now + 1 * H, done: false },
      { semester: "114-1", id: "o2", course: "（舊學期）普通物理", title: "實驗報告", due: now + 2 * H, done: false }
    ],
    notices: [
      { semester: "115-1", id: "n1", course: "程式設計（C++）", title: "期中考範圍公告", posted: now - 2 * H, read: false },
      { semester: "115-1", id: "n2", course: "資料結構", title: "下週改為線上上課", posted: now - 1 * D, read: false },
      { semester: "115-1", id: "n3", course: "課輔中心", title: "課輔志工時數登錄提醒", posted: now - 4 * D, read: true },
      { semester: "114-2", id: "n9", course: "（舊學期）微積分", title: "成績公告", posted: now - 120 * D, read: true }
    ]
  };
})();
