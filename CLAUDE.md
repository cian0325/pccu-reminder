# 堂數點名簿 — 專案說明（給 Claude Code）

才藝教室（塗鴉班／幼兒班／兒童班／進階班）老師用的 iPhone PWA：點名、調課補課、停課、整期／點數制繳費、收入統計、Excel 匯出。
使用者是教室老師，用繁體中文溝通，UI 文字一律繁體中文（台灣用語）。

## 技術與檔案

- 純 HTML + CSS + 原生 JavaScript，**沒有框架、沒有建置步驟**。整個 App 在 `index.html` 一個檔案裡。
- `sw.js`：Service Worker，網路優先、離線時用快取。**每次改版要把開頭的快取名稱 `const C='rollbook-vN'` 的 N 加 1**，手機才會換新版。
- `manifest.webmanifest`、`icon-*.png`：加入 iPhone 主畫面用。
- 外部資源：Google Fonts（霞鶩文楷 TC、思源黑體 TC、IBM Plex Mono）；SheetJS `xlsx@0.18.5` 由 cdnjs 在匯出時才動態載入。
- 部署：把整個資料夾上傳到 HTTPS 靜態空間（GitHub Pages / Netlify），用 Safari「加入主畫面」。

本機測試：`python3 -m http.server 8000` 後開 `http://localhost:8000`。

## 資料（最重要的規則）

- 全部存在 `localStorage['rollbook.v3']`，一個 JSON 物件 `S`。
- **絕對不要改 KEY 或丟掉舊欄位**：老師手機裡有真實資料。新增欄位時在檔尾 `S=load()||seed();` 後面補預設值（現有的遷移寫法：`S.levels=S.levels||defaultLevels();…`）。
- 改動資料格式前，先確認「設定 → 備份與還原」的匯入（`App._import`）也能處理舊備份。

```
S = {
  settings: { studio, unitPrice, haptic, sound, lastBackup },
  levels:   [{ id, name, tone }]                       // 班級類別，tone 決定顏色 0–5
  slots:    [{ id, wd, start:'HH:MM', end, name, level }]   // 每週固定時段，wd 0=日
  terms:    [{ id, name, start:'YYYY-MM-DD', weeks, price }] // 期別；price = 每堂價格；結束日 = start + weeks*7 - 1
  students: [{ id, name, level, plan:'term'|'points', phone, note, active,
               slotHist:[{ from:'YYYY-MM-DD', slotId }] }]   // 時段調整歷史，依生效日
  records:  [{ id, sid, date, key:slotId, status:'present'|'absent', mk? }] // 點名；mk = 補課/加課的 makeup id
  makeups:  [{ id, sid, absId|null, date, slotId, type?:'credit', termId?, purchaseId? }]
            // absId=補哪一堂沒來的課；absId=null 是加課；type='credit' 是折抵學費（不是實際上課）
  purchases:[{ id, sid, kind:'term'|'points', termId, lessons, amount, adj, adjReason,
               date, paid, paidDate, method, note }]
  closures: [{ id, date, slotId|null, reason }]        // 停課；slotId=null 全天
  confirmed:{ 'YYYY-MM-DD|slotId': { at: timestamp } } // 已按「確認點名」的時段
  sample?: true                                        // 範例資料旗標
}
```

## 核心規則（改邏輯前先讀）

- **剩餘堂數** `bal(sid)` = 已購堂數 − 狀態為「到」的紀錄數（正課、補課、加課都扣）。「沒來」不扣。
- **應上堂數** `sessions()` / `termLessons()`：依學生當天的固定時段（`slotOn`）計算，排除停課（`isClosed`）。
- **待補課** `pendingAbs()`：正課「沒來」且沒有對應的補課或折抵（補課又沒來時會回到待補）。
- **續期試算** `renewal(s, T, keep, adj)`：需繳 = 下期應上 − 可結轉（`carryInto`）+ 保留補課的堂數；金額 = 需繳 × 每堂價格 + 調整。`carryInto` 會預扣本期還沒上的課和已排的補課。
- **點名草稿**：按「到／沒來」只改 `UI.drafts`，按「確認點名」（`App._confirm`）才寫入 `records`，並記在 `confirmed`。
- 停課不算應上、不扣堂、不進待補。已確認點名的時段不能設停課。

## 程式結構（index.html 的 `<script>`）

依區塊註解 `/* ---------- 區塊 ---------- */` 排列：工具函式 → storage → 時段 → 班級類別 → 補課 → 堂數計算 → 範例資料 `seed()` → UI → 點名 `vRoll` → 調課 `vMakeup` → 學生 `vStudents` → 繳費 `vPay` → 統計 `vStats` → 設定 `vSettings` → 停課 → 期末未補課清單 → 學生查詢 → 按鍵回饋 → 檔案輸出（Excel、.ics）→ `App` 物件（所有 onclick 的動作）。

- 畫面用字串樣板產生 HTML，`render()` 重畫目前分頁；彈出面板用 `sheet(html)`。
- 所有使用者輸入顯示前都要經過 `esc()`。
- 確認對話框用自製的 `confirmSheet()`，不要用 `confirm()`/`alert()`。
- 存檔用 `saveFile()`（iPhone 會跳分享選單）。

## 設計

- 色彩全部用 CSS 變數（`--paper --card --ink --ink-2 --line --indigo --seal --amber --green --violet`），淺色、深色兩套都要定義。
- 字體：標題 `--f-display`（霞鶩文楷），內文 `--f-body`，數字 `--f-num` + tabular-nums。
- 手機優先：最窄 360px 不可橫向捲動；注意 `env(safe-area-inset-*)`。
- 尊重 `prefers-reduced-motion`。

## 下一步計畫（老師已同意的方向）

1. **雲端同步**（先做）：Firebase 或 Supabase 擇一（尚未決定，先比較後跟老師確認）。老師登入後資料同步到雲端，保留離線使用；第一次登入時把 localStorage 資料搬上去。
2. **作品分頁**（老師端，加在這個 App）：拍照記錄繪畫過程（選學生 → 選或新增作品 → 連拍），自動偵測畫紙四角並裁切拉正（例如 OpenCV.js / jscanify），依「學生 → 作品 → 照片」存到雲端。
3. **家長作品頁**（另做一個網站，共用同一個雲端）：家長用帳號密碼或專屬連結＋密碼登入，只能看到自己孩子的作品集和繪畫過程。必須用資料庫權限規則確保家長看不到其他學生或繳費資料。
4. 選做：每位學生一張 QR Code 小卡，拍作品時掃描自動分類。

**不做人臉辨識**：兒童生物特徵屬敏感個資，辨識也不穩定。改用「先選學生再拍照」或 QR Code。上傳兒童照片前需取得家長同意，家長頁要有隱私說明。

## 其他待辦想法

剩餘堂數提醒＋續費訊息、各類別不同價格、家長聯絡資訊、自動備份提醒、時段人數上限、材料費與支出記帳、體驗課／候補名單、升班紀錄、生日提醒。
