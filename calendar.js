// 學校行事曆：中國文化大學 115 學年度（日間部）
// 來源：https://www.pccu.edu.tw/calendar/old_calendar/115calendar.pdf
// 經 115 年 4 月 15 日第 1839 次行政會議通過。依 PDF 逐筆整理，事件名稱照原文；
// 若學校修改行事曆，以學校公告為準。
//
// 欄位說明：
//   start / end     日期 "YYYY-MM-DD"（單日事件 end 可省略）
//   title           事件名稱（照 PDF 原文）
//   type            holiday 放假｜exam 考試｜course 選課・註冊｜term 學期｜makeup 補課・調整上課｜deadline 截止｜other 其他
//   noClass         true：當天停課，不顯示下一堂課、不發上課提醒
//   followsWeekday  補課日改上星期幾的課（0=日 … 6=六）
//   scope           只適用特定對象（例如「研究生」）；不出現在首頁與提醒
//   derived         由其他事件的附註整理出來的日期（不是 PDF 上單獨一列）
//
// semesters：各學期「上課期間」= 開始上課日 ～ 第 18 週最後一天（含彈性教學週）。
// 期間以外（寒暑假）不會出現上課提醒。
window.SCHOOL_CALENDAR = {
  year: "115",
  source: "115 學年度行事曆（PDF）",
  sourceUrl: "https://www.pccu.edu.tw/calendar/old_calendar/115calendar.pdf",
  loaded: true,
  semesters: {
    "115-1": { start: "2026-09-14", end: "2027-01-17" },
    "115-2": { start: "2027-02-22", end: "2027-06-27" }
  },
  events: [
    // ===== 第 1 學期 =====
    { start: "2026-08-01", title: "第1學期開始", type: "term" },
    { start: "2026-08-26", title: "創辦人逝世紀念日", type: "other" },
    { start: "2026-09-07", title: "註冊繳費截止日", type: "deadline" },
    { start: "2026-09-14", title: "開始上課日；休、退學免繳學費截止日", type: "term" },
    { start: "2026-09-14", end: "2026-09-16", title: "博士班研究生申請學位論文考試", type: "other", scope: "研究生" },
    { start: "2026-09-14", end: "2026-09-20", title: "第2階段選課", type: "course" },
    { start: "2026-09-21", end: "2026-09-22", title: "校際選課；隨班附讀", type: "course" },
    { start: "2026-09-23", end: "2026-09-24", title: "選課更正", type: "course" },
    { start: "2026-09-25", title: "中秋節【放假一天】", type: "holiday", noClass: true },
    { start: "2026-09-28", title: "孔子誕辰紀念日【放假一天】", type: "holiday", noClass: true },
    { start: "2026-10-09", title: "國慶日補假【放假一天】", type: "holiday", noClass: true },
    { start: "2026-10-10", title: "國慶日【放假一天】", type: "holiday", noClass: true },
    { start: "2026-10-25", title: "臺灣光復暨金門古寧頭大捷紀念日【放假一天】", type: "holiday", noClass: true },
    { start: "2026-10-26", title: "臺灣光復暨金門古寧頭大捷紀念日補假【放假一天】", type: "holiday", noClass: true },
    { start: "2026-10-27", title: "休、退學學生退2/3學雜費截止日", type: "deadline" },
    { start: "2026-10-27", end: "2026-10-29", title: "碩士班研究生申請學位論文考試", type: "other", scope: "研究生" },
    { start: "2026-11-02", end: "2026-11-08", title: "期中考試週", type: "exam" },
    { start: "2026-11-07", title: "校友返校節【補116年1月22日調整放假，上班一天】", type: "other" },
    { start: "2026-11-09", title: "創辦人誕辰紀念日", type: "other" },
    { start: "2026-11-11", title: "紀念創辦人誕辰路跑活動", type: "other" },
    { start: "2026-11-23", end: "2026-11-27", title: "棄修申請", type: "course" },
    { start: "2026-12-07", title: "休、退學學生退1/3學雜費截止日", type: "deadline" },
    { start: "2026-12-21", end: "2026-12-29", title: "115學年度第2學期第1階段(分年級)選課", type: "course" },
    { start: "2026-12-25", title: "行憲紀念日【放假一天】", type: "holiday", noClass: true },
    { start: "2026-12-28", end: "2027-01-03", title: "期末考試週【至116年1月3日，逢1月1日開國紀念日放假之考試延後至116年1月8日舉行】", type: "exam" },
    { start: "2027-01-01", title: "開國紀念日【放假一天】", type: "holiday", noClass: true },
    { start: "2027-01-04", end: "2027-01-17", title: "彈性教學週", type: "other" },
    { start: "2027-01-04", title: "外文：英文閱讀與聽講(一)、(二)期末會考", type: "exam" },
    { start: "2027-01-08", title: "期末考試（1月1日開國紀念日放假之考試延後舉行）", type: "exam", derived: true },
    { start: "2027-01-21", title: "休學及自動退學截止日", type: "deadline" },
    { start: "2027-01-22", title: "校友返校節調整放假【放假一天】", type: "holiday", noClass: true },
    { start: "2027-01-29", end: "2027-02-18", title: "全校休假【至2月18日】(含農曆除夕、春節放假)", type: "holiday", noClass: true },
    { start: "2027-01-31", title: "第1學期結束", type: "term" },

    // ===== 第 2 學期 =====
    { start: "2027-02-01", title: "第2學期開始", type: "term" },
    { start: "2027-02-17", title: "校慶補假【放假一天】", type: "holiday", noClass: true },
    { start: "2027-02-18", title: "畢業典禮調整放假【放假一天】", type: "holiday", noClass: true },
    { start: "2027-02-19", title: "註冊繳費截止日", type: "deadline" },
    { start: "2027-02-22", title: "開始上課日；休、退學免繳學費截止日", type: "term" },
    { start: "2027-02-22", end: "2027-02-24", title: "博士班研究生申請學位論文考試", type: "other", scope: "研究生" },
    { start: "2027-02-22", end: "2027-02-28", title: "第2階段選課", type: "course" },
    { start: "2027-02-25", title: "65周年校慶慶祝大會", type: "other" },
    { start: "2027-02-28", title: "和平紀念日【放假一天】", type: "holiday", noClass: true },
    { start: "2027-03-01", title: "和平紀念日補假【放假一天】", type: "holiday", noClass: true },
    { start: "2027-03-01", title: "65周年校慶紀念日", type: "other" },
    { start: "2027-03-02", end: "2027-03-03", title: "校際選課；隨班附讀", type: "course" },
    { start: "2027-03-04", end: "2027-03-05", title: "選課更正", type: "course" },
    { start: "2027-04-04", title: "兒童節【放假一天】", type: "holiday", noClass: true },
    { start: "2027-04-05", title: "民族掃墓節【放假一天】", type: "holiday", noClass: true },
    { start: "2027-04-06", title: "兒童節補假【放假一天】", type: "holiday", noClass: true },
    { start: "2027-04-12", end: "2027-04-14", title: "碩士班研究生申請學位論文考試", type: "other", scope: "研究生" },
    { start: "2027-04-12", title: "休、退學學生退2/3學雜費截止日", type: "deadline" },
    { start: "2027-04-12", end: "2027-04-18", title: "期中考試週", type: "exam" },
    { start: "2027-04-15", end: "2027-05-13", title: "轉系申請", type: "course" },
    { start: "2027-04-30", title: "勞動節補假【放假一天】", type: "holiday", noClass: true },
    { start: "2027-05-01", title: "勞動節【放假一天】", type: "holiday", noClass: true },
    { start: "2027-05-03", end: "2027-05-07", title: "棄修申請", type: "course" },
    { start: "2027-05-17", title: "休、退學學生退1/3學雜費截止日", type: "deadline" },
    { start: "2027-05-24", end: "2027-05-30", title: "應屆畢業生期末考試", type: "exam", scope: "應屆畢業生" },
    { start: "2027-06-02", title: "期末考試（6月9日端午節放假之考試提前舉行）", type: "exam", derived: true },
    { start: "2027-06-05", title: "畢業典禮【補2月18日調整放假，上班一天】", type: "other" },
    { start: "2027-06-07", end: "2027-06-13", title: "期末考試週【至13日，逢6月9日端午節放假之考試提前至6月2日舉行】", type: "exam" },
    { start: "2027-06-09", title: "端午節【放假一天】", type: "holiday", noClass: true },
    { start: "2027-06-14", end: "2027-06-27", title: "彈性教學週", type: "other" },
    { start: "2027-06-14", title: "外文：英文閱讀與聽講(一)、(二)期末會考", type: "exam" },
    { start: "2027-06-21", end: "2027-06-25", title: "116學年度第1學期第1階段(分年級)選課", type: "course" },
    { start: "2027-06-28", title: "暑假開始【7、8月逢週五不上班】", type: "term" },
    { start: "2027-06-30", title: "碩士班研究生申請逕修讀博士班學位", type: "other", scope: "研究生" },
    { start: "2027-07-05", end: "2027-07-08", title: "全校休假【至8日】", type: "holiday", noClass: true },
    { start: "2027-07-22", title: "休學及自動退學截止日", type: "deadline" },
    { start: "2027-07-31", title: "第2學期結束", type: "term" }
  ]
};
