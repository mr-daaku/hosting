# CoCo/Credit App — prompt8.md (App logo + new welcome image)

## 1. Replace the app logo

New app logo image: `https://github.com/mr-daaku/hosting/blob/main/cocotaskbot/1000056791-removebg-preview.png`

Note: that's a GitHub **blob** URL (renders an HTML preview page, not the raw image bytes) — use the raw form instead so it actually loads as an image asset:
`https://raw.githubusercontent.com/mr-daaku/hosting/main/cocotaskbot/1000056791-removebg-preview.png`

Apply this new logo everywhere the app logo is currently used:
- `public/favicon.png` (replace the file/asset)
- `tonconnect-manifest.json` → `iconUrl` (currently pointing at the old favicon)
- The in-app round app logo used on the loading screen (percentage-fill loading animation) and top bar/header, per the earlier logo spec
- Any other place the app icon/logo currently renders (PWA/meta tags, etc.)

## 2. `/start` welcome image — generate a new one

`WELCOME_IMAGE` (in `telegram.server.ts`) currently points to a static `welcome-coco.jpg`. Replace it with a **newly generated** welcome image — not the old CoCo-branded one, and not the app-logo image from §1 either — a proper welcome/banner-style graphic that fits the current branding (dark background, brand green `#BCE356`, reflecting the "Credit" rebrand from the last update) suitable for a Telegram bot's `/start` photo message. Host it and update the `WELCOME_IMAGE` constant to point to the new file, so the bot sends this new image (with the existing short caption + single "Open App" button) whenever someone sends `/start`.

---

**Before finishing:** confirm the new app logo renders correctly wherever the old one used to (favicon, TonConnect manifest icon, in-app logo/loading screen), and confirm `/start` now sends the newly generated welcome image, not the old `welcome-coco.jpg`.
