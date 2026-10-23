# Telegram Wallet Bot + Mini App — Security, Anti-Fraud & Performance Specification

> **Purpose:** Give this document to Lovable as the implementation specification for a production-minded Telegram wallet bot and Mini App.
>
> **Important:** Do not claim the app is secure merely because UI controls exist. Enforce all security, authorization, balance, reward, and transaction rules on the server. Never use demo/mock financial logic in production. This specification is a baseline, not a guarantee against every possible attack. Have the finished system independently security-reviewed before handling real funds.

## 0. Instructions to Lovable

Build the app in small, verifiable phases. First inspect the existing project and preserve working functionality. Do not replace or remove existing features without explaining why. Before coding, report the current stack, database, authentication flow, deployment environment, and any missing secrets or external services.

- Use the existing project stack where practical. If starting fresh, prefer a supported TypeScript frontend and server-side API, with a relational database.
- If using Supabase, use Auth/Edge Functions/Postgres appropriately, strict Row Level Security (RLS), and server-only service-role secrets. If using Cloudflare Workers + D1, perform authorization in Workers and use D1 transactions/batched statements carefully. Do not mix assumptions from different stacks.
- Telegram Mini App: validate raw `Telegram.WebApp.initData` on the server using Telegram's documented validation procedure. Never authenticate with `initDataUnsafe`, a client-supplied Telegram user ID, a username, or a screenshot.
- Do not store private keys, seed phrases, signing secrets, bot tokens, database service keys, or provider API secrets in frontend code, public environment variables, browser storage, Telegram messages, or logs.
- Create migrations, typed API contracts, automated tests, seed/demo data only in a separate non-production environment, and a setup guide.
- Do not claim a feature is implemented unless the code, tests, and configuration actually implement it. List external configuration that still requires a human.
- No hidden backdoors, hard-coded admin IDs as the sole control, public debug endpoints, or bypasses for rate limits and verification.
- All financial amounts must use integer base units or a safe fixed-precision decimal representation. Never use JavaScript floating-point arithmetic for money.
- Never expose stack traces, SQL errors, provider secrets, internal risk rules, or sensitive account data to users.

## 1. Threat model and assets

Protect:
- Telegram identities and user sessions.
- Internal balances, deposits, withdrawals, transfers, rewards, referral credits, fees, and transaction history.
- Blockchain private keys, signing authority, deposit addresses, and RPC credentials.
- Admin accounts, configuration, audit logs, bot token, database, backups, and deployment pipeline.
- Service availability, user privacy, and correctness of displayed balances.

Assume attackers can:
- Modify frontend JavaScript, HTML, network requests, request parameters, local storage, and device clocks.
- Call APIs directly without opening the UI; automate requests with scripts and bots.
- Replay captured requests, submit concurrent requests, create many accounts, manipulate referral links, and inspect public frontend code.
- Use VPNs, proxies, shared networks, emulators, multiple devices, and compromised accounts.
- Send malformed payloads, oversized requests, unexpected data types, and malicious text/URLs.
- Abuse legitimate features, third-party provider outages, blockchain reorganizations, and race conditions.
- Attempt phishing, credential/token theft, social engineering, supply-chain attacks, and admin compromise.

Do not assume IP address, device fingerprint, CAPTCHA, Telegram account age, or any one signal proves a person is legitimate. Use layered risk scoring and proportionate controls.

## 2. Authentication and Telegram Mini App

- Validate Telegram `initData` server-side using the official HMAC/signature validation flow and bot token handling recommended by Telegram. Use constant-time comparison where applicable.
- Reject missing, malformed, invalidly signed, or expired `initData`; enforce a short configurable maximum age and clock-skew allowance.
- Prevent replay where appropriate with short-lived server sessions, one-time nonces/request IDs for sensitive operations, and server-side replay controls.
- Exchange verified `initData` for a short-lived server session. Rotate session identifiers after authentication and privilege changes.
- Use secure, HttpOnly, SameSite cookies where compatible, or a carefully designed bearer-token approach. Never place long-lived secrets in localStorage.
- Apply CSRF protections to cookie-authenticated state-changing requests; validate Origin/Host and use appropriate SameSite settings.
- Require HTTPS only; configure HSTS at the hosting edge where supported.
- Use Telegram numeric user ID as the stable identity key; usernames and display names are mutable and not unique.
- Do not trust user IDs, role, balance, account status, referral owner, transaction status, or admin claims sent by the client.
- Log out/revoke sessions on account suspension, suspicious activity, and credential/session rotation.
- Keep bot tokens on the server. Restrict bot webhook routes with Telegram's secret token header, validate request shape, and make webhook processing idempotent.
- Protect deep links and `start`/`startapp` referral parameters from tampering. Treat them as untrusted input until validated server-side.
- Avoid collecting unnecessary personal data. Publish privacy/retention information appropriate to the service.

## 3. Authorization and account isolation

- Deny by default. Every endpoint must check authentication, ownership, account state, and role on the server.
- Users may read/update only fields explicitly allowed for their own account. Never accept a client-provided owner ID to select another user's records.
- Enforce object-level authorization on every transaction, wallet, address, reward, referral, and profile resource (prevent IDOR/BOLA).
- Separate user, support, finance, security, and super-admin roles. Use least privilege and scoped permissions.
- Admin-only actions must be checked on the server for every request, not just hidden in the UI.
- Require MFA/passkeys or the strongest supported step-up authentication for administrators. Protect recovery paths.
- For high-risk admin changes (withdrawal limits, RPC endpoints, signing configuration, admin roles, pause/resume), require re-authentication and preferably two-person approval.
- Use allowlisted fields for profile updates; reject mass assignment of `role`, `balance`, `is_admin`, `verified`, `risk_status`, or transaction state.
- Use separate staging and production credentials and databases.

## 4. Fake accounts, Sybil abuse, and bot detection

- Add configurable rate limits for account/session creation, login/initData exchange, referral claims, reward claims, address creation, and sensitive actions.
- Use a risk score from multiple signals: request velocity, account age, repeated device/network patterns, referral graph patterns, failed verification, unusual transaction patterns, and prior abuse.
- Use IP/network reputation only as one signal; avoid permanently blocking an entire shared network due to one user.
- Device signals must be privacy-conscious, disclosed where required, and never treated as definitive identity proof. Avoid invasive fingerprinting unless legally justified and disclosed.
- Apply new-account limits: reward eligibility delays, referral payout holds, low initial withdrawal limits, and gradual trust increases. Clearly show users the rules.
- Detect referral loops, self-referrals, cyclic referral graphs, repeated payment destinations, repeated claim timing, and clusters of accounts funded by the same source.
- Prevent one event or reward claim from being credited more than once using database uniqueness constraints and idempotency.
- Add adaptive challenges (CAPTCHA or another challenge) only when risk warrants them; verify challenge results server-side. CAPTCHA is not a replacement for authorization/rate limiting.
- Use manual review and appeal paths for uncertain cases. Do not rely on a single heuristic for permanent account bans.
- Record reason codes and evidence for risk actions; avoid exposing exact detection thresholds to public clients.
- Add abuse controls for promo codes, giveaways, campaigns, task completion, loyalty points, and any free-credit feature.

## 5. API security and script abuse

- Put all business rules in the backend. Frontend validation is for usability only.
- Validate every request against a strict schema: type, required fields, allowed values, lengths, numeric ranges, and object shape. Reject unexpected fields on sensitive endpoints.
- Enforce maximum request body sizes, pagination limits, query limits, and timeouts.
- Use per-IP, per-user, per-session, and per-endpoint rate limits. Apply stricter limits to login, OTP/challenge, rewards, referrals, withdrawals, and admin routes.
- Add global concurrency limits and backpressure for expensive operations.
- Return generic error messages and stable error codes; do not leak stack traces, SQL, internal IDs, secrets, or whether sensitive accounts exist.
- Use CORS allowlists for known origins. CORS is not authentication and must not be relied upon to stop scripts.
- Validate Origin/Host where relevant, but understand non-browser clients can forge headers.
- Use idempotency keys for financial mutations. Store key + user + operation + request hash + final result with a unique constraint and expiry/retention policy. A retry with the same key must return the original result, not execute again.
- Reject replayed one-time challenges and stale signed payloads.
- Do not put secrets in URLs/query strings. Avoid sensitive information in analytics and referrer headers.
- Use API versioning and documented request/response contracts.
- Avoid exposing internal RPC/proxy endpoints or arbitrary URL-fetch features to clients.
- Add per-user and global quotas for costly RPC calls, external API calls, exports, and search.
- Do not trust client timestamps, prices, fees, confirmation counts, success flags, or task-completion claims.
- Keep admin APIs separate from public APIs and require explicit authorization on every route.

## 6. Database, SQL, and data integrity

- Use parameterized queries/ORM-safe queries; never concatenate user input into SQL.
- Enforce foreign keys, unique constraints, check constraints, not-null constraints, and indexes in the database, not only in application code.
- Enable and test RLS for Supabase/Postgres. Client-facing roles must not read or write another user's data or financial tables. Never ship a service-role key to the client.
- For D1, ensure all writes occur through authenticated server-side Workers; do not expose database credentials or create unauthenticated write endpoints.
- Use database transactions for balance changes and all multi-step financial state changes. Use row locks/serializable isolation or atomic conditional updates appropriate to the database.
- Prevent race conditions with atomic updates such as “debit only if available balance >= amount” and a unique transaction/idempotency key.
- Store immutable ledger entries; do not edit or delete historical financial ledger records to “fix” a balance. Use reversal/adjustment entries with reason and audit trail.
- Keep user-facing profile data separate from financial ledger, secrets, and admin audit data.
- Add indexes for actual query patterns; inspect query plans for hot endpoints.
- Use migrations under version control and test them against a staging copy. Avoid destructive migrations without backups and a rollback plan.
- Use connection pooling where supported; keep transactions short; never hold a DB transaction open while waiting for a blockchain/RPC call.
- Use database time for critical timestamps and server-side state transitions.
- Back up data on a defined schedule, encrypt backups where supported, restrict access, and regularly test restoration.
- Define data retention and deletion rules without deleting records legally/operationally required for financial integrity.

## 7. Balance, ledger, transfers, and double-spend protection

- Maintain an authoritative server-side ledger. A displayed balance is derived from trusted ledger/accounting state, not client values.
- Prefer double-entry accounting: each movement has balanced debit/credit entries, asset and network identifiers, unique transaction reference, and timestamps.
- Separate available, pending, locked, and reserved balances.
- Validate asset, network, decimals, minimum/maximum amount, fee, destination, and account status on the server.
- Use integer smallest units (e.g. token base units) or safe decimal libraries. Never use floating-point arithmetic for amounts.
- Make transfer/withdrawal operations atomic: reserve/debit funds and create the transaction record in one database transaction.
- Enforce invariant: available balance must never become negative; ledger debits and credits must reconcile.
- Use a state machine such as `created -> pending_review/queued -> processing -> submitted -> confirmed` and explicit `failed/cancelled/reversed` states. Reject invalid transitions.
- Use an outbox/queue pattern for external blockchain submission. Do not call the blockchain and then hope a database write succeeds without a recovery strategy.
- Store external provider transaction hashes uniquely per network when appropriate. Handle timeout-after-submit by checking provider/chain state before retrying.
- Run reconciliation jobs comparing ledger state, internal transaction state, and blockchain/provider observations. Alert on mismatches.
- Add a global emergency pause for withdrawals and a separate switch for deposits/rewards if needed. Pause must not corrupt pending transaction state.
- Never allow support/admin tools to arbitrarily edit a balance. Use audited adjustment transactions with limits and optional second approval.

## 8. Deposits and blockchain-specific protection

- Do not credit a deposit based solely on a user-submitted transaction hash or screenshot.
- Verify transactions server-side through a trusted node/provider or independently operated RPC: chain/network, destination, token contract/mint, amount, asset, transaction success, and relevant event/log.
- Use an allowlist of supported chain IDs, token contracts/mints, and decimals. Never accept a token merely because its symbol says USDT/USDC.
- Confirm the transaction on the correct network and wait for configurable confirmation/finality rules appropriate to that chain and value. Handle reorgs and dropped/replaced transactions.
- Credit deposits idempotently using a unique chain + transaction hash + event/log index (or chain-specific equivalent).
- For account-based chains, account for multiple transfers/events within one transaction. Do not assume one transaction hash equals one deposit.
- Handle memo/tag/comment requirements where applicable; show clear instructions and warn when a memo is required.
- Treat provider webhooks as untrusted until their signature/authentication is validated; then independently verify high-value events against chain data.
- Rate-limit and cache RPC reads; use timeouts, retries with exponential backoff and jitter, circuit breakers, and provider fallback. Never retry a financial write blindly.
- Detect unsupported tokens, wrong networks, fee-on-transfer tokens, token decimals mismatches, and dust spam.
- Show deposits as pending until verified; clearly communicate confirmation requirements.
- Keep provider outage status separate from confirmed/failed transaction status.
- Do not publish deposit addresses or transaction details belonging to other users.
- Never promise that all blockchain transfers are reversible; clearly explain wrong-network/address risks.

## 9. Withdrawals, private keys, and signing

- Private keys/seed phrases must never be sent to the frontend, Telegram, logs, analytics, database rows readable by ordinary app roles, or support staff.
- For custodial wallets, use a reputable key-management/signing architecture (HSM/KMS/MPC or a well-reviewed isolated signer) appropriate to the threat model. Do not invent custom cryptography.
- Keep signer isolated from the public API. The API sends a narrowly scoped, authenticated signing request; the signer independently validates policy and amount/destination limits.
- Keep hot-wallet funds limited; use cold storage or a segregated treasury process where appropriate.
- Require address/network validation, withdrawal limits, risk checks, velocity checks, available-balance reservation, and destination allowlisting/step-up checks when appropriate.
- Use withdrawal cooldowns for changed security settings/new destinations/new accounts, with clear user notices.
- For high-value or high-risk withdrawals, hold for manual/two-person approval. Make thresholds configurable and never expose secrets in frontend config.
- Use transaction simulation/policy checks where supported; validate fee/gas limits and prevent arbitrary contract calls.
- Track nonce/sequence management, replacement transactions, pending submissions, chain congestion, and failed broadcasts.
- Do not mark a withdrawal completed merely because the RPC submission returned success; verify on-chain state and required finality.
- Protect against replay and duplicate withdrawal with idempotency and unique transaction records.
- Provide an emergency stop and key-rotation/compromise runbook. Never silently delete pending withdrawals.
- If implementing non-custodial wallets, do not request users' seed phrases. Clearly distinguish wallet connection/signature requests from custody.
- A software-only secret in an environment variable is not equivalent to an HSM/KMS; document residual risk.

## 10. Referral, rewards, tasks, and promotions

- Calculate eligibility, amounts, caps, time windows, and completion server-side.
- Create unique claim records with database uniqueness constraints, such as one claim per user/campaign/period.
- Make claim operations atomic and idempotent.
- Do not credit rewards based on frontend-only timers, hidden buttons, localStorage flags, client screenshots, or client-submitted completion status.
- Validate third-party task/ad callbacks and signatures where supported; otherwise treat them as unverified signals and add abuse controls.
- Keep reward balances pending until required checks complete.
- Prevent self-referrals, cycles, repeated account/device/network patterns, referral parameter tampering, and duplicate rewards.
- Apply campaign budgets, per-user caps, global caps, expiry, and kill switches.
- Log reward creation, hold, release, reversal, and admin override as ledger events.
- Do not penalize users solely for using a VPN or shared IP.
- Document reward rules clearly and support appeal/manual review.

## 11. Admin panel and operational security

- Require MFA/passkeys where available; use individual accounts, not shared admin logins.
- Enforce least privilege and separate read-only support access from finance/security controls.
- Protect admin routes and server actions with authorization on every request.
- Require re-authentication for secrets, admin role changes, wallet settings, withdrawals, RPC changes, and security control changes.
- Use dual approval for critical/high-value operations where practical.
- Audit who did what, when, from where, and the before/after values; never log secrets.
- Make audit logs append-only or tamper-evident and restrict deletion.
- Add admin session expiry, login rate limits, alerts on new devices/unusual access, and immediate session revocation.
- Store bot token and API keys in a secret manager/deployment secrets, not in source control.
- Rotate leaked credentials immediately. Do not paste production secrets into Lovable prompts, chat, issues, or client code.
- Keep production and test bot tokens, webhook secrets, database projects, and RPC credentials separate.
- Restrict deployment and repository access; enable MFA and review dependency changes.
- Provide admin emergency controls for withdrawal pause, reward pause, account suspension, provider disable, and maintenance mode. Each action must be authorized and audited.

## 12. Web, frontend, and browser security

- Prevent XSS: escape untrusted text, sanitize allowed rich text, avoid unsafe HTML injection, and use a restrictive Content Security Policy where hosting permits.
- Prevent CSRF for cookie-authenticated mutations.
- Validate redirects and deep links against an allowlist; do not accept arbitrary redirect URLs.
- Prevent clickjacking with suitable frame restrictions where compatible with Telegram Mini Apps.
- Set appropriate security headers: HSTS, `X-Content-Type-Options: nosniff`, a suitable `Referrer-Policy`, and a carefully tested CSP.
- Avoid storing sensitive information in localStorage/sessionStorage. Treat all browser storage as user-editable.
- Do not put auth tokens, private data, or secrets in analytics, URLs, crash reports, or frontend logs.
- Render user-provided names, memos, addresses, and messages as text, not executable HTML.
- Validate uploaded files by size/type/content; rename uploads, isolate storage, and do not execute uploaded content.
- Use secure, expiring upload/download URLs and check ownership before issuing them.
- Apply dependency lockfiles, automated vulnerability scanning, and regular updates. Pin or review critical dependencies.
- Do not expose source maps or debug tools containing secrets; public frontend code itself is not a secret.

## 13. Infrastructure, DDoS, and availability

- Put the public API behind the hosting provider's WAF/DDoS controls where available.
- Use endpoint-specific rate limits and body-size limits; global limits alone are insufficient.
- Set execution timeouts and concurrency budgets. Use queues for slow RPC, email, notification, reconciliation, and other non-interactive work.
- Apply circuit breakers and bounded retries with exponential backoff + jitter. Avoid retry storms.
- Add provider health checks, fallbacks where safe, and a clear degraded-mode response.
- Cache public/static data with short, appropriate TTLs; never cache user-specific balances or authenticated responses in a shared cache.
- Use request coalescing/deduplication for repeated public reads and cache expensive metadata.
- Add pagination, query limits, indexes, and response-size limits.
- Keep health endpoints minimal and do not reveal secrets, database details, or internal topology.
- Use maintenance mode and a clear user-facing status page/message during outages.
- Test backup restoration, deployment rollback, provider outage behavior, and traffic spikes.
- Monitor resource usage, error rate, latency, database saturation, queue depth, RPC failure rate, and rate-limit events.

## 14. Performance and fast user experience

Security must not be bypassed to make the app faster. Optimize common paths instead.

- Keep the Mini App bundle small; split routes/features, remove unused dependencies, compress assets, and lazy-load non-critical screens.
- Prefer server-side pagination and selective queries. Never fetch the full transaction history or all users at once.
- Add indexes for user ID + created time, transaction status + created time, unique chain transaction references, and other measured hot queries.
- Avoid N+1 queries; batch reads where safe and fetch only required columns.
- Cache static config, token metadata, public prices, and non-sensitive reference data with explicit TTLs and stale-data handling.
- Do not cache balances, authorization results, or sensitive user-specific data in shared/public caches.
- Keep API responses small and stable. Use loading skeletons, optimistic UI only for reversible UI state, and clear pending status for financial actions.
- Do not show a transaction as successful until the server confirms it. For pending transactions, return a transaction ID and poll/back off or use realtime updates.
- Use WebSocket/realtime only when it improves the experience; reconnect with backoff, authenticate subscriptions, and limit event scope to the user's own data.
- Use queues/background jobs for blockchain confirmation polling, reconciliation, notifications, risk analysis, and reports.
- Set database query budgets and performance targets; measure p50/p95/p99 latency and error rate.
- Use bounded concurrency for RPC and provider calls. Respect provider limits and prevent one user from exhausting shared capacity.
- Prefer connection reuse and platform-supported pooling. Keep database transactions short.
- Use pagination cursors rather than large offsets for long histories when supported.
- Compress HTTP responses where supported and use CDN caching for static assets.
- Avoid polling every second indefinitely. Use exponential backoff and pause background polling when the app is hidden.
- Provide a responsive mobile UI, avoid heavy animations, and ensure actions are accessible.
- Add a performance test with realistic concurrent users and transaction workloads; do not claim “fast” without measurements.

Suggested initial targets (adjust after measuring the deployment):
- Static UI route loads quickly on a typical mobile connection; keep initial JS bundle lean and monitor bundle size.
- Common non-financial API p95 under 300–500 ms under expected load, where infrastructure permits.
- Financial API p95 under 500–800 ms excluding blockchain finality/external provider latency, where infrastructure permits.
- No unbounded queues, retry loops, or unbounded database queries.
These are targets, not guarantees; report actual test results.

## 15. Monitoring, audit, and incident response

- Use structured logs with request/correlation ID, route, latency, status, and safe internal identifiers.
- Never log bot tokens, authorization headers, session tokens, private keys, seed phrases, full sensitive payloads, or raw `initData`.
- Add alerts for: elevated 4xx/5xx, authentication failures, rate-limit spikes, unusual account creation, reward spikes, withdrawal spikes, ledger mismatch, failed reconciliation, signer errors, RPC outages, and admin changes.
- Keep security events separate from normal application logs where practical.
- Define incident severities, owner/contact, escalation steps, and evidence retention.
- Prepare runbooks for bot-token leak, admin compromise, database leak, private-key compromise, suspicious withdrawals, DDoS, provider outage, and accidental destructive migration.
- On suspected key compromise: pause signing/withdrawals, protect evidence, follow key-rotation and treasury incident procedures, notify affected parties as appropriate, and investigate.
- Test restore procedures and emergency pause periodically.
- Show users transaction status and incident notices without exposing internal detection methods.

## 16. Privacy and abuse-resistant UX

- Collect only data needed for service operation, fraud prevention, and legal obligations.
- Set clear retention periods for IP/device risk signals and audit records; restrict access to sensitive logs.
- Avoid exposing a user's wallet addresses, balance, transaction history, referral tree, or Telegram ID to other users.
- Do not use device fingerprinting as a covert substitute for consent or identity verification.
- Explain cooldowns, pending reviews, limits, and failed transactions clearly.
- Provide a support and appeal flow for risk holds and mistaken restrictions.
- Never ask users to send seed phrases, private keys, passwords, or OTPs to support/admins.

## 17. Error handling and state correctness

- Use typed, consistent errors: invalid input, unauthorized, forbidden, rate limited, conflict/idempotent replay, temporarily unavailable, and internal error.
- Do not silently convert failed financial operations into success.
- For network timeouts, reconcile external state before retrying a financial action.
- Use explicit transaction states and legal transitions; never trust a status value sent by the frontend.
- Make background jobs safe to run more than once.
- Use dead-letter handling and admin review for repeatedly failing financial jobs.
- Ensure notification failure does not undo a valid transaction and notification success does not imply transaction success.
- Use UTC for stored timestamps and display localized times in the UI.

## 18. Testing requirements — do not skip

Create automated unit, integration, authorization, and end-to-end tests for at least the following:

### Authentication and access
- Invalid/missing/expired Telegram `initData` is rejected.
- A client cannot impersonate another Telegram user by changing a user ID.
- A normal user cannot call admin APIs or change their role/balance/status.
- User A cannot read or alter User B's wallet, address, transactions, or referrals.
- Revoked/expired sessions cannot perform actions.
- CSRF, CORS, and origin protections are tested for the chosen auth model.

### Abuse and API
- Burst requests are rate-limited.
- Oversized/malformed payloads are rejected safely.
- Duplicate idempotency keys do not duplicate side effects.
- Replayed reward/referral claims are rejected.
- Scripted requests cannot bypass server-side validation.
- CAPTCHA/challenge failure or missing verification blocks protected actions when required.

### Financial integrity
- Two concurrent withdrawals cannot spend the same funds.
- Two concurrent claims cannot credit the same reward twice.
- Negative amounts, zero amounts where invalid, excessive precision, overflow, unsupported assets, and invalid destinations are rejected.
- Available balance never goes negative.
- Ledger debit/credit entries reconcile.
- Provider timeout after submission does not create a duplicate transaction.
- Duplicate blockchain event/webhook is credited once.
- Wrong chain, wrong token contract, failed transaction, and insufficient confirmations do not credit deposits.
- State transitions reject impossible changes.
- Emergency pause blocks new withdrawals while preserving the status of existing ones.

### Admin and operations
- Critical admin actions require correct role and step-up checks.
- Admin changes are audit-logged and logs contain no secrets.
- Backup restore and deployment rollback are tested.
- Provider outage, rate limit, RPC timeout, and database error fail safely.

### Security and performance
- Run dependency and secret scanning.
- Test for SQL injection, XSS, IDOR/BOLA, CSRF (where applicable), SSRF if any URL-fetch feature exists, and unsafe file uploads.
- Run load tests for expected concurrent usage and a spike scenario.
- Verify p95/p99 latency, error rates, DB query plans, queue depth, and rate limiting.
- Perform an independent security review before real-money launch.

Use only an authorized staging environment and test accounts. Do not run destructive tests against production or third-party systems.

## 19. Suggested implementation order

1. **Foundation:** environment separation, secret handling, migrations, strict schemas, logging, health checks.
2. **Identity:** Telegram `initData` verification, server sessions, authorization, RLS/object ownership tests.
3. **Ledger:** integer amounts, ledger schema, atomic balance operations, idempotency, concurrency tests.
4. **Abuse controls:** rate limiting, referral/reward anti-fraud, risk holds, audit events.
5. **Blockchain:** deposit verification, confirmations/reorg handling, withdrawal queue, isolated signer and pause control.
6. **Admin:** roles, MFA/step-up, dual approval for critical actions, audit trail.
7. **Performance:** query/index review, caching safe data, queues, load tests and latency measurements.
8. **Release:** staging acceptance, restore/rollback test, threat-model review, external security review, then controlled launch.

## 20. Acceptance criteria

Do not call the implementation production-ready until:
- Every sensitive endpoint has server-side authentication, authorization, validation, and rate limits.
- Telegram Mini App authentication is verified server-side.
- Client cannot change balances, roles, transaction status, reward eligibility, or chain confirmation status.
- Financial writes are atomic, idempotent, auditable, and tested under concurrency.
- Blockchain deposits are independently verified and duplicate events cannot double-credit.
- Private keys and signing secrets are isolated from the public app.
- Admin access is strongly protected and sensitive actions are audited.
- RLS/policies and object ownership tests pass for the selected stack.
- Backup restore, emergency pause, and incident procedures are tested.
- No known critical/high severity security findings remain unresolved.
- Load-test results and measured p95/p99 latencies are documented.
- Any incomplete controls, external dependencies, and residual risks are clearly listed.

## 21. Official references

Use current official documentation during implementation; do not copy outdated snippets blindly.

- Telegram Mini Apps: https://core.telegram.org/bots/webapps
- Telegram Bot API: https://core.telegram.org/bots/api
- OWASP API Security: https://owasp.org/www-project-api-security/
- OWASP Cheat Sheet Series: https://cheatsheetseries.owasp.org/
- Supabase Row Level Security: https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase Edge Functions: https://supabase.com/docs/guides/functions
- Cloudflare Workers security: https://developers.cloudflare.com/workers/
- Cloudflare rate limiting: https://developers.cloudflare.com/waf/rate-limiting-rules/
- Cloudflare D1: https://developers.cloudflare.com/d1/
- NIST Secure Software Development Framework: https://csrc.nist.gov/Projects/ssdf

## Final instruction to Lovable

Implement the actual controls in code, database policies, migrations, tests, and deployment configuration—not just a checklist or UI mockup. Work in phases and report for each requirement: **implemented file/location, enforcement point, test added, result, and any manual setup still required**. If a control cannot be implemented in the current stack or plan, say so explicitly and provide the safest practical alternative. Never weaken a security control to improve speed; optimize the implementation instead.
