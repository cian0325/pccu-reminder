# 前端邏輯測試

用最小假 DOM 在 Node 執行 `pwa/app.js`，驗證完成、貪睡、優先度、學期過濾、通知觸發等行為。

```bash
node tests/smoke.js pwa
BRIEF_WINDOW=1 node tests/smoke.js pwa   # 模擬剛過每日總覽時間
```

```bash
node tests/mine.js pwa                   # 手動輸入資料、示範橫幅、刪除與切換
```

```bash
node tests/import.js pwa                 # 匯入 JSON、重複匯入、錯誤輸入
python3 tests/parser_test.py             # C++ 解析器（需要 g++），使用 tests/fixtures 的去識別化假頁面
```

`tests/fixtures/` 的頁面結構與實際系統相同，但內容全部是虛構的，可以安全公開。

```bash
node tests/calendar.js pwa               # 行事曆邏輯（停課、補課、學期期間、篩選），使用測試用假行事曆
node tests/calendar_real.js pwa          # 用真實 115 學年度行事曆驗證固定日期（國慶、春節、寒假、開學）
```

```bash
node tests/notices_crawl.js pwa          # 公告內文頁（含 HTML 跳脫、連結過濾）、爬蟲作業匯入與重新同步
python3 tests/crawler_e2e.py             # 爬蟲對模擬課輔系統（tests/mock_icas）的完整流程，需要 Playwright 與 g++
```

`tests/mock_icas/` 是模擬的課輔系統，內容全部虛構。

```bash
node tests/cloud.js pwa                  # Claude 網頁版：雲端同步（模擬資料庫）、不重複匯入、保留完成標記、格式錯誤不覆蓋
```
