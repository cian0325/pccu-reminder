#!/usr/bin/env python3
"""把 pwa/ 的 App 組成一個可以發佈成 Claude Artifact 的單一 HTML 檔。

  python3 tools/build_artifact.py  → dist/pccu-reminder.html

同一份程式碼兩種用法：
  * pwa/（GitHub Pages）：可加入 iPhone 主畫面、可發手機通知；資料用「匯入」更新
  * dist/pccu-reminder.html（Claude Artifact）：資料由 Claude 爬蟲後寫進雲端資料庫，打開就是最新；
    Claude 網頁不能發手機通知，提醒改顯示在畫面上
app.js 依 window.claude 是否存在自動切換。
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# 專案資料夾裡是 pwa/；GitHub repo 裡網站檔案直接放在根目錄（GitHub Pages）
PWA = ROOT / "pwa" if (ROOT / "pwa" / "index.html").exists() else ROOT
OUT = ROOT / "dist" / "pccu-reminder.html"

# Artifact 版的主題與版面：深色為主（與 App 相同），淺色依系統或 Claude 的主題切換；
# 側邊留白與頂部安全區依 Claude Artifact 的頁面規範。
ARTIFACT_CSS = """
/* 版面：頂部固定標題列 + 內容 + 底部分頁列，手機寬度優先 */
:root{
  --bg:#0f172a; --card:#1e293b; --line:#334155; --text:#f1f5f9; --muted:#94a3b8;
  --accent:#38bdf8; --on-accent:#04202e; --warn:#f59e0b; --danger:#f87171; --ok:#4ade80;
  color-scheme:dark;
}
@media (prefers-color-scheme: light){
  :root:not([data-theme="dark"]){
    --bg:#f1f5f9; --card:#ffffff; --line:#dbe3ee; --text:#0f172a; --muted:#5b6b80;
    --accent:#0369a1; --on-accent:#ffffff; --warn:#b45309; --danger:#dc2626; --ok:#15803d;
    color-scheme:light;
  }
}
:root[data-theme="light"]{
  --bg:#f1f5f9; --card:#ffffff; --line:#dbe3ee; --text:#0f172a; --muted:#5b6b80;
  --accent:#0369a1; --on-accent:#ffffff; --warn:#b45309; --danger:#dc2626; --ok:#15803d;
  color-scheme:light;
}
body{background:var(--bg);color:var(--text)}
body::before{content:"";position:fixed;inset:0 0 auto;height:env(safe-area-inset-top,0px);z-index:10;background:var(--bg)}
header{top:env(safe-area-inset-top,0px);padding-block:12px 10px;
  padding-left:max(16px, env(safe-area-inset-left,0px));padding-right:max(16px, env(safe-area-inset-right,0px))}
main{padding-block:12px calc(84px + env(safe-area-inset-bottom,0px));
  padding-left:max(16px, env(safe-area-inset-left,0px));padding-right:max(16px, env(safe-area-inset-right,0px))}
nav{padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)}
.btn{color:var(--on-accent)}
.list li,.card{min-width:0}
"""


def main() -> None:
    css = (PWA / "style.css").read_text(encoding="utf-8")
    # App 版的淺色主題區塊改由上面的三段式主題取代
    css, n = re.subn(r"@media \(prefers-color-scheme: light\)\{\s*:root\{[^}]*\}\s*\}", "", css)
    assert n == 1, "style.css 的淺色主題區塊格式改變了，請更新 build_artifact.py"
    css = css.replace("color:#04202e", "color:var(--on-accent)")

    html = (PWA / "index.html").read_text(encoding="utf-8")
    body = html[html.index("<body>") + len("<body>"): html.index("</body>")]
    body = re.sub(r'<script src="[^"]+"></script>\s*', "", body)
    assert "<script" not in body

    scripts = "".join(
        f"<script>\n{(PWA / name).read_text(encoding='utf-8')}\n</script>\n"
        for name in ("data.js", "calendar.js", "app.js")
    )
    page = (
        '<title>課輔提醒</title>\n'
        '<meta name="claude:viewport-fit-sides" content="cover">\n'
        f"<style>\n{css}\n{ARTIFACT_CSS}\n</style>\n"
        f"{body.strip()}\n{scripts}"
    )
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(page, encoding="utf-8")
    print(f"{OUT}（{len(page.encode('utf-8')) // 1024} KB）")


if __name__ == "__main__":
    main()
