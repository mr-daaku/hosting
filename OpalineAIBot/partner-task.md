# Partner Task System (reusable spec)

Build a "Partner Task" feature for a Telegram Mini App. A partner task is a task card shown to users; the reward is given only after the server calls the partner's API and the reply matches admin-defined rules. No eval / no dynamic code — everything is JSON config.

## 1. Admin flow
1. **Create task (frontend JSON)** — what the user sees:
```json
{
  "title": "Join PartnerApp",
  "description": "Open PartnerApp and finish level 1",
  "button_text": "Open",
  "link": "https://t.me/PartnerBot?start={user_id}",
  "icon_url": "https://example.com/icon.png",
  "reward": 0.01,
  "max_completions": 1000
}
```
2. **Request JSON** — which partner API the server calls when the user taps Check:
```json
{
  "method": "GET",
  "url": "https://api.partner.com/check?user_id={user_id}",
  "headers": { "Authorization": "Bearer PARTNER_KEY" }
}
```
   - Placeholders: `{user_id}`, `{username}`, `{task_id}`. `method`: GET or POST (POST may have a `body` object, placeholders allowed).
   - Only `https://` URLs. Block private hosts (localhost, 127.*, 10.*, 192.168.*, 172.16–31.*, 169.254.*, *.local, *.internal). 8 second timeout. Read max 4000 chars.
3. **Rules JSON** — which reply values confirm the reward:
```json
{
  "match": "all",
  "conditions": [
    { "path": "ok", "op": "equals", "value": true },
    { "path": "user.joined", "op": "truthy" },
    { "path": "user.level", "op": "gte", "value": 1 }
  ]
}
```
   - `match`: `all` (every condition) or `any` (at least one).
   - `op`: equals, not_equals, truthy, falsy, exists, gt, gte, lt, lte, contains (array includes / string includes).
   - `path`: dot path into the JSON reply, array index allowed: `data.items[0].done`.
   - Max 20 conditions. Reward passes only if HTTP status is 2xx AND rules pass.
4. **Test** — button runs the real request with fixed test user ID `7206619137` and shows: PASS/FAIL, HTTP status, each condition (expected vs got), and the full reply JSON.
5. **Save & Activate** — task goes live. Statuses: draft, active, paused, delete.

## 2. User flow
- Card: round icon (image fills the circle, `object-cover rounded-full`), title, description, reward, button.
- Tap button → open `link` (with `{user_id}` filled) → after 2s the button becomes **Check**.
- Check → server function: verify Telegram initData (HMAC with BOT_TOKEN), rate limit 6/min per user, load task backend (only if active), run request + rules, then call an atomic SQL function `complete_partner_task(task, user)` that: locks the task row, rejects if already completed by this user (unique task_id+user_id), rejects if max_completions reached, inserts completion, increments counter, credits balance through the ledger. Return reward; remove the card from the list.

## 3. Database
- `partner_tasks(id uuid, title, description, button_text, link, icon_url, reward numeric, max_completions int null, completions int default 0, status text, backend jsonb, created_at)`
- `partner_completions(task_id, user_id, reward, created_at, unique(task_id,user_id))`
- RLS on, no public policies; all access via server functions with the service-role client.

## 4. Demo partner API (for testing)
`GET /api/public/partner-demo?user_id=7206619137` returns:
```json
{"ok":true,"user":{"id":7206619137,"joined":true,"level":3,"tasks":["start","level1"]},"message":"User completed the partner task"}
```
With the rules above the test result is **PASS**.

## 5. Unit tests to keep
- All conditions match the demo reply → pass.
- level 0 with `gte 1` → fail.
- `match: any` with one true condition → pass.
- Private host URL → rejected.
