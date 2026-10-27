# 課輔提醒爬蟲

在**你自己的電腦**上執行，讀取課業輔導系統裡的作業與公告，產生 App 可匯入的 `my-data.json`。

為什麼不能直接在手機的 App 裡爬：課輔系統需要登入，而且網頁內容是用 JavaScript 載入的；
PWA 受瀏覽器安全限制（CORS），不能讀取其他網站，也不該保存你的帳號密碼。

```
你的電腦                                          iPhone
┌───────────────────────────────┐                ┌──────────────┐
│ pccu_crawler.py（Playwright）  │  my-data.json  │  課輔提醒 App │
│  ├ 用你登入過的瀏覽器工作階段讀頁面 │ ─────────────▶ │  設定 → 匯入   │
│  └ pccu_parser（C++）解析作業截止 │ （iCloud 雲碟） └──────────────┘
└───────────────────────────────┘
```

## 安裝（一次）

需要 Python 3.9 以上與 C++ 編譯器（Mac：`xcode-select --install`；Windows：安裝 MSYS2 的 g++ 或 Visual Studio 的 clang）。

```bash
pip install playwright
python3 -m playwright install chromium
```

`pccu_parser` 第一次執行時會自動用 g++ 編譯 `server-cpp/pccu_parser.cpp`。

## 第一次：自己登入

```bash
cd crawler
python3 pccu_crawler.py --login
```

會打開一個瀏覽器視窗，請你**自己**輸入帳號密碼登入。看到「我的課程」清單後程式會自動繼續。

- 程式不會讀取、也不會保存你的帳號密碼。
- 登入後的 Cookie 存在 `~/.pccu-crawler/`（權限只有你自己能讀）。刪掉這個資料夾就等於登出。
- 登入多久會過期是學校系統決定的。過期時程式會顯示「請執行 --login」並以代碼 3 結束，重新登入一次即可。

## 之後：每次執行

```bash
python3 pccu_crawler.py --out ~/Library/Mobile\ Documents/com~apple~CloudDocs/課輔提醒/my-data.json
```

不加 `--out` 時，檔案存在 `~/pccu-reminder-data/my-data.json`。存到 iCloud 雲碟的話，iPhone 上就能直接選到：
App →「設定 → 管理我的課程與作業 → 匯入資料」→ 選擇檔案 → iCloud 雲碟 → 課輔提醒 → `my-data.json`。

- Mac 的 iCloud 雲碟：`~/Library/Mobile Documents/com~apple~CloudDocs/`
- Windows（iCloud for Windows）：`%USERPROFILE%\iCloudDrive\`

匯入時，先前爬到的作業會被新的取代（手動新增的作業不受影響）；你在 App 裡標的完成、重要、進度、備註都會保留。

## 會做什麼

1. 打開課業輔導系統首頁，確認目前學期（例如 115-1）；頁面顯示舊學期時會自動切換。
2. 讀取課程清單與「最新公告」，並逐一點開公告取得內文與附件連結。
3. 逐一打開每門課的「作業」頁，取出每一列的文字，交給 C++ 的 `pccu_parser homework` 判斷截止時間。
4. 寫出 `my-data.json` 與 `crawl-report.txt`（需要注意的事項）。

每頁之間間隔 2 秒（`--delay` 可調整），一次大約 30–60 秒。建議一天執行 1–2 次就好。

### 截止時間的判斷規則

| 作業列的內容 | 結果 |
|---|---|
| 日期前有「截止、期限、結束、繳交期限、Due、~、至」，或欄名是「截止日期」 | 確定的截止時間 |
| 兩個以上沒有標示的日期（例如 `12/01 - 12/20`） | 取最晚的日期，App 標示「推測」 |
| 只有一個沒有標示的日期 | **不產生提醒**，寫進 crawl-report.txt |
| 「繳交時間 / 上傳時間」 | 視為你交作業的時間，永遠不當成截止 |

日期只有年月日時，截止時間取當天 23:59；民國年（`115/11/05`）會轉成西元年；「下午 01:30」會轉成 13:30。

## 選項

| 選項 | 說明 |
|---|---|
| `--login` | 打開瀏覽器視窗讓你登入 |
| `--out 檔案` | 輸出位置 |
| `--no-notice-content` | 不點開公告。**點開公告會讓課輔系統把它標成已讀**，不想這樣就加這個選項 |
| `--delay 秒數` | 每頁間隔（預設 2） |
| `--semester 115-1` | 指定學期（預設依今天日期） |
| `--headed` | 顯示瀏覽器視窗，看它在做什麼 |
| `--dump 資料夾` | 把讀到的頁面存下來，用來調整解析規則。**內含個人資料，不要上傳到公開的地方** |

## 自動排程（選用）

Mac（每天 7:00 和 19:00）：`crontab -e` 加入一行
```
0 7,19 * * * cd /路徑/pccu-reminder/crawler && /usr/bin/python3 pccu_crawler.py --out "$HOME/Library/Mobile Documents/com~apple~CloudDocs/課輔提醒/my-data.json" >> "$HOME/pccu-crawl.log" 2>&1
```
macOS 可能要求給 cron「完整磁碟取用權限」才能寫入 iCloud 雲碟（系統設定 → 隱私權與安全性）。

Windows（每天 7:00）：
```
schtasks /create /sc daily /st 07:00 /tn "課輔提醒爬蟲" /tr "python C:\路徑\pccu-reminder\crawler\pccu_crawler.py --out %USERPROFILE%\iCloudDrive\課輔提醒\my-data.json"
```

排程只會在電腦開著、而且登入沒過期時成功。

## 已用實際頁面驗證（2026/10/27，115-1，13 門課）

- 作業頁是 div 版面：`.MateTitleBlock` 是欄名（狀態／更新日期／截止日期／作業標題），每份作業一個 `.MateBlock`；截止日期只有年月日（視為當天 23:59）。
- 狀態有「未繳交」「已閱讀」。「已閱讀」是老師已檢視你交的作業：首頁的待繳數（7 份）正好等於「未繳交」的份數，所以視為已完成。
- 首頁「最新作業」括號裡的日期是**更新日期**，不是截止日（例如 EX1 首頁寫 10/23，實際截止 11/5）。
- 有些作業沒有填截止日期（例如只有表單連結），這些不會產生提醒，寫在 crawl-report.txt。
- 公告點開是 `#Popup` 彈出視窗，內文在 `#popMessage`，開頭有「發佈老師：」「公告內容：」；關閉鈕是 `.AnnoBtn`。
- 未登入時頁面仍顯示課程清單標題，內容是「Login」，所以登入判斷看的是「標題是 4 位數學期」或「看得到登出」。

`tests/mock_icas` 的模擬網站照這些結構製作，測試會檢查上面每一點。

## 目前的限制

- 以上是 115-1 的頁面；學校改版時規則可能要調整。`crawl-report.txt` 出現大量「無法判斷」時，用 `--dump` 存下頁面協助調整。
- 公告只會讀首頁「最新公告」列出的幾則（目前是 5 則）。
- 使用前請確認學校對自動化存取的規定；只用來讀取你自己的資料。
