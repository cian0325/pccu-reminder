課輔提醒：Windows 自動爬蟲
================================

這個資料夾讓你的電腦每天 20:00 自動登入「文大課業輔導系統」，把作業和公告存到 data\crawl.json。
Claude 的每日排程（20:30）會讀這個檔，用 C++ 解析截止時間，再更新「課輔提醒」。

安裝：雙擊 setup.bat
  1. 自動安裝 Playwright（瀏覽器自動化）和 keyring（Windows 認證管理員）
  2. 輸入學號和密碼（密碼存在 Windows 認證管理員，不會寫進任何檔案，也不會傳給 Claude）
  3. 試跑一次，成功後在「工作排程器」建立每天 20:00 的工作「PCCU 課輔爬蟲」
     （20:00 電腦沒開的話，開機後會補跑）

改了學校密碼：再雙擊一次 setup.bat
停用：雙擊 uninstall.bat（刪除排程和存好的密碼）

檔案
  auto_crawl.py        登入與爬取（Python + Playwright）
  crawl_in_browser.js  在課輔系統頁面裡讀取課程、公告、作業（與 Claude 瀏覽器窗格用的同一支）
  data\crawl.json      最新爬取結果（含你的課程資料，不要上傳到公開的地方）
  data\status.json     最近一次執行是否成功
  data\last-run.log    最近一次執行紀錄（不含密碼）
