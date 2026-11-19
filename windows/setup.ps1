# 課輔提醒：Windows 自動爬蟲安裝程式（由 setup.bat 執行）
# 1. 找 Python  2. 安裝 Playwright、keyring 與瀏覽器  3. 輸入學號密碼（存進 Windows 認證管理員）並試跑
# 4. 在「工作排程器」建立每天 20:00 的工作「PCCU 課輔爬蟲」（電腦當時沒開的話，開機後補跑）
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'

function Find-Python {
  $c = @()
  $cmd = Get-Command python -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source -notlike '*WindowsApps*') { $c += $cmd.Source }
  $c += Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | ForEach-Object FullName
  $c += "$env:USERPROFILE\anaconda3\python.exe", "$env:USERPROFILE\miniconda3\python.exe", "$env:ProgramData\anaconda3\python.exe"
  foreach ($p in $c) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}

$py = Find-Python
if (-not $py) {
  Write-Host '找不到 Python。請先到 https://www.python.org/downloads/ 安裝（勾選 Add python.exe to PATH），再重新執行 setup.bat。' -ForegroundColor Red
  exit 1
}
$pyDir = Split-Path $py
# Anaconda 沒有「啟動環境」時，pip 會找不到 SSL 等 DLL：先把它的資料夾放進 PATH
$env:PATH = "$pyDir;$pyDir\Library\bin;$pyDir\Library\mingw-w64\bin;$pyDir\Scripts;$env:PATH"
Write-Host "使用 Python：$py" -ForegroundColor Cyan

Write-Host "`n[1/3] 安裝 Playwright 與 keyring…" -ForegroundColor Cyan
& $py -m pip install --user --upgrade playwright keyring
if ($LASTEXITCODE -ne 0) { Write-Host 'pip 安裝失敗。' -ForegroundColor Red; exit 1 }
& $py -m playwright install chromium
if ($LASTEXITCODE -ne 0) { Write-Host '下載瀏覽器失敗。' -ForegroundColor Red; exit 1 }

Write-Host "`n[2/3] 設定帳號密碼並試跑…" -ForegroundColor Cyan
& $py "$here\auto_crawl.py" --setup
if ($LASTEXITCODE -ne 0) { Write-Host '試跑沒有成功，排程沒有建立。修正後請重新執行 setup.bat。' -ForegroundColor Red; exit 1 }

Write-Host "`n[3/3] 建立每天 20:00 的排程…" -ForegroundColor Cyan
$pyw = Join-Path $pyDir 'pythonw.exe'
if (-not (Test-Path $pyw)) { $pyw = $py }
$action = New-ScheduledTaskAction -Execute $pyw -Argument "`"$here\auto_crawl.py`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -Daily -At '20:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName 'PCCU 課輔爬蟲' -Action $action -Trigger $trigger -Settings $settings `
  -Description '每天登入文大課業輔導系統，把作業與公告存到 data\crawl.json（課輔提醒）' -Force | Out-Null

Write-Host "`n完成！每天 20:00 會自動爬取，結果在：$here\data" -ForegroundColor Green
Write-Host '回到 Claude 跟它說「設定好了」。'
