// 示範資料（假資料）。串接後端後，改由 /api/summary 回傳相同格式。
// 作業與公告的時間以「相對現在」產生，方便隨時展示。
(function () {
  const H = 3600 * 1000, D = 24 * H;
  const now = Date.now();

  window.DEMO_DATA = {
    source: "demo",
    // weekday: 1=週一 … 5=週五
    schedule: [
      { weekday: 1, start: "09:10", end: "12:00", course: "程式設計（C++）", room: "大典館 B101", teacher: "王老師" },
      { weekday: 2, start: "13:10", end: "15:00", course: "資料結構", room: "大孝館 305", teacher: "李老師" },
      { weekday: 3, start: "10:10", end: "12:00", course: "離散數學", room: "大忠館 202", teacher: "陳老師" },
      { weekday: 4, start: "09:10", end: "12:00", course: "程式設計（C++）實習", room: "大典館 電腦教室", teacher: "王老師" },
      { weekday: 5, start: "14:10", end: "16:00", course: "計算機概論", room: "大成館 401", teacher: "林老師" }
    ],
    tasks: [
      { id: "a1", course: "程式設計（C++）", title: "作業三：類別與運算子多載", due: now + 5 * H, done: false },
      { id: "a2", course: "資料結構", title: "實作鏈結串列（linked list）", due: now + 2 * D + 3 * H, done: false },
      { id: "a3", course: "離散數學", title: "習題 4.1–4.3", due: now + 6 * D, done: false },
      { id: "a4", course: "程式設計（C++）", title: "作業二：指標與動態記憶體", due: now - 3 * D, done: true }
    ],
    notices: [
      { id: "n1", course: "程式設計（C++）", title: "期中考範圍公告", posted: now - 2 * H, read: false },
      { id: "n2", course: "資料結構", title: "下週改為線上上課", posted: now - 1 * D, read: false },
      { id: "n3", course: "課輔中心", title: "課輔志工時數登錄提醒", posted: now - 4 * D, read: true }
    ]
  };
})();
