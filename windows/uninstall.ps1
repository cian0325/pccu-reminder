# 停用自動爬蟲：刪除排程與存好的帳號密碼
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Unregister-ScheduledTask -TaskName 'PCCU 課輔爬蟲' -Confirm:$false -ErrorAction SilentlyContinue
$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py -or $py -like '*WindowsApps*') { $py = "$env:USERPROFILE\anaconda3\python.exe" }
if (Test-Path $py) { & $py "$here\auto_crawl.py" --forget }
Write-Host '已刪除排程「PCCU 課輔爬蟲」與存好的帳號密碼。'
