# 照片切切樂 後端部署步驟

需要：Cloudflare 帳號、Node.js。R2 為私有儲存，**不要**開啟公開存取或綁定公開網域。

1. 登入：`npx wrangler login`
2. 建立資料庫：`npx wrangler d1 create photo-ninja`，把輸出的 database_id 貼進 wrangler.toml
3. 建立私有儲存：`npx wrangler r2 bucket create photo-ninja-photos`
4. 建立資料表：`npx wrangler d1 execute photo-ninja --remote --file=schema.sql`
5. 設定簽名金鑰（隨機長字串）：`npx wrangler secret put SIGN_SECRET`
6. 修改 wrangler.toml 裡的 [vars]（三個網址）
7. 部署：`npx wrangler deploy`
8. 驗證：打開 `https://<你的 worker 網址>/api/play/abcdefghijklmnop`，應回傳 410 gone

選用：
- 寄信：`npx wrangler secret put RESEND_API_KEY`（需 Resend 帳號與已驗證的寄件網域）
- 防濫用：`npx wrangler secret put TURNSTILE_SECRET`，建立者網頁需送 token；另建議在 Cloudflare 後台對 POST /api/games 加上速率限制規則

之後會補上：public/play.html（遊玩頁）與建立者網頁（放 GitHub Pages）。
