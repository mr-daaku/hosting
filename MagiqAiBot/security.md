# Security Policy & Implementation Checklist

> **Purpose:** This document defines the minimum security, privacy, and data-retention requirements for this Telegram Mini App. Apply these rules to the frontend, backend, database, admin panel, APIs, and any payment or blockchain integrations.
>
> **Core principles:** Store the minimum data needed, keep secrets server-side, verify everything on the backend, deny access by default, and maintain a trustworthy financial ledger.
>
> **Important:** No application can be guaranteed 100% hack-proof. Security controls must be tested, monitored, and updated continuously.

---

## 1. Data minimization and privacy

Collect and retain only information that is necessary to provide the service, prevent abuse, meet applicable legal obligations, and resolve disputes.

### Data that may be necessary

| Data | Minimum handling requirement |
|---|---|
| Telegram user ID | Store only if needed to identify the account. Treat it as a personal identifier; never expose it publicly. |
| Account status | Store a small status field, such as active, restricted, or deleted. |
| App preferences | Store only preferences that are needed to restore the user experience. |
| Financial ledger | Store transaction references, amounts, asset/network, status, and timestamps when required for accounting and dispute resolution. |
| Deposit/withdrawal address | Store only when required to process or reconcile a transaction. Restrict access and define a retention period. |
| Security events | Store concise event type, timestamp, and relevant internal account reference. Avoid logging secrets or full request bodies. |
| Admin actions | Store actor, action, target, timestamp, and reason for accountability. |

### Do not collect or store unless strictly required

- Real name, email address, phone number, date of birth, or home address.
- Contact lists, Telegram messages, profile photos, or unrelated Telegram profile information.
- Precise location, device fingerprint, advertising identifiers, or persistent tracking IDs.
- Passwords for Telegram accounts, Telegram login codes, bot tokens, session cookies, or users' private keys/seed phrases.
- Full IP history or full user-agent history when a short-lived abuse signal is sufficient.
- Complete API request/response bodies, especially when they may contain credentials or personal data.
- Duplicate copies of the same user or transaction data across tables and services.
- Data “just in case” without a defined purpose, owner, and deletion schedule.

### Data lifecycle requirements

- Document the purpose and retention period for every stored field.
- Delete or anonymize data when its purpose ends, subject to applicable legal, accounting, and dispute-retention requirements.
- Provide a user account deletion process where appropriate. Explain any records that must be retained and why.
- Keep backups only for a documented, limited period; ensure deleted data expires from backups according to the backup lifecycle.
- Restrict access to production data. Use synthetic or anonymized data for development and testing.
- Never sell user data. Do not use it for unrelated profiling or marketing without a valid legal basis and appropriate user choice.
- Do not promise “zero data retention” if logs, backups, payment records, or legal obligations mean otherwise.

---

## 2. Telegram Mini App authentication

- Validate Telegram Mini App `initData` on the backend using Telegram's documented validation procedure and bot token.
- Never treat `initDataUnsafe` or a user ID supplied by the client as proof of identity.
- Check the authentication timestamp and reject expired or replayed authentication data according to the app's session policy.
- Derive the authenticated user identity from verified data on the server.
- Do not accept a client-supplied `user_id` to decide whose account is being accessed.
- Use short-lived application sessions. Revoke sessions after logout, account restriction, or suspected compromise.
- Keep the Telegram bot token exclusively in server-side secret storage. Rotate it immediately if exposed.
- Require fresh authentication for sensitive operations when appropriate.

---

## 3. Authorization and access control

- Deny access by default; grant only the permissions required for each action.
- Enforce authorization on every backend endpoint, not just in the interface.
- Check resource ownership on the server for every user-specific read or write.
- Use role-based access control for users, support staff, operators, and administrators.
- Separate admin endpoints from user endpoints and protect them with stronger controls.
- Never rely on hidden buttons, frontend route guards, or client-side role flags as security boundaries.
- Prevent insecure direct object reference (IDOR) vulnerabilities: changing an ID must never expose another user's data.
- Review permissions whenever a role, endpoint, or database table is added or changed.

---

## 4. Database security

- Keep the database private; access it only through trusted backend services.
- Use least-privilege database credentials and separate credentials for development, staging, and production.
- Never place service-role keys, database passwords, or privileged credentials in frontend code, public repositories, or client-side environment variables.
- Enable and test Row Level Security (RLS) where supported. Policies must be restrictive and based on verified identity.
- Use parameterized queries or safe query builders. Never concatenate untrusted input into SQL.
- Validate types, ranges, lengths, and allowed values before database writes.
- Use database constraints for invariants such as unique transaction references and valid status values.
- Use atomic transactions for financial state changes. Do not update a balance separately from its corresponding ledger entry.
- Encrypt data in transit and use encryption at rest where supported.
- Limit database network access and rotate credentials after staff changes or suspected exposure.
- Back up production data securely and test restoration regularly.
- Do not copy production data into local development environments unless it has been appropriately anonymized.

---

## 5. Financial ledger and balance integrity

**The backend and ledger are the source of truth. The frontend must never determine or set a real balance.**

- Maintain an append-only or otherwise tamper-evident ledger for deposits, withdrawals, fees, rewards, refunds, and administrative adjustments.
- Record each financial event with a unique internal ID, event type, asset, network, amount in precise units, status, and timestamp.
- Use integer base units or a safe decimal representation. Avoid floating-point arithmetic for money.
- Make credit/debit operations atomic and idempotent so retries cannot double-credit or double-debit.
- Enforce uniqueness for external transaction identifiers in the correct network/asset context.
- Verify deposits independently on the backend against a trusted blockchain node/provider or payment processor.
- Check network, token contract/mint, destination, amount, transaction status, and required confirmations.
- Never credit funds based only on a frontend callback, screenshot, client-submitted hash, or unverified webhook.
- Verify webhook signatures where available; reject invalid, stale, or duplicate events.
- Apply withdrawal limits, risk checks, and appropriate approval controls. Use a hold/review state for suspicious activity.
- Reconcile internal ledger records against external transaction data on a schedule.
- Alert on negative balances, duplicate references, mismatched totals, or unexpected ledger changes.
- Keep administrative adjustments auditable, permissioned, and accompanied by a reason.
- Never store user seed phrases or private keys. If the service controls signing keys, isolate them in an appropriate key-management system and restrict signing permissions.

---

## 6. API security

- Require HTTPS for all production traffic.
- Apply rate limits by account and, where appropriate, IP or other abuse signals.
- Validate every request on the server; reject unexpected fields and malformed input.
- Set request size limits, timeouts, and sensible pagination limits.
- Configure CORS to allow only the origins actually required. CORS is not authentication.
- Protect state-changing endpoints against replay and duplicate processing.
- Use CSRF protections if the authentication/session design makes them relevant.
- Return generic client errors; never reveal stack traces, SQL errors, secrets, internal paths, or infrastructure details.
- Avoid excessive data exposure. Return only fields the current user needs.
- Do not put secrets, authentication tokens, or sensitive personal data in URLs.
- Inventory endpoints and disable unused, deprecated, debug, and test routes in production.
- Apply abuse controls to resource-intensive operations to reduce denial-of-service risk.

---

## 7. Frontend and browser security

- Treat all client code, browser storage, and client-submitted values as untrusted.
- Keep secrets and privileged logic on the backend.
- Escape output and sanitize untrusted HTML to prevent cross-site scripting (XSS).
- Use a restrictive Content Security Policy (CSP) where feasible.
- Avoid unsafe HTML rendering and untrusted script injection.
- Do not store sensitive credentials or financial secrets in `localStorage`, `sessionStorage`, or URLs.
- Do not expose internal error messages or debug data in production builds.
- Keep dependencies updated and remove unused packages.
- Use secure, maintained libraries and pin or lock dependency versions.
- Test the app in a browser with developer tools and a proxy; assume attackers can modify requests.

---

## 8. Admin panel security

- Require multi-factor authentication (MFA/2FA) for administrators.
- Use separate admin accounts; never share credentials.
- Apply least privilege and separate support, finance, and system-administration permissions.
- Require re-authentication or additional approval for high-impact actions.
- Protect admin sessions with secure cookies or an equivalent secure session mechanism, short expiry, and revocation.
- Rate-limit login attempts and notify on suspicious admin access.
- Log sensitive admin actions: actor, action, target, timestamp, result, and reason. Do not log passwords, tokens, or secret values.
- Require explicit confirmation for destructive or financial actions.
- Use dual approval for high-value transfers or critical configuration changes when appropriate.
- Provide an emergency procedure to disable withdrawals, revoke sessions, and rotate compromised secrets.
- Review admin access periodically and remove access immediately when no longer needed.

---

## 9. Secrets and cryptographic key management

- Store secrets in a managed secret store or protected server-side environment, never in source control or frontend bundles.
- Use separate secrets for each environment and service.
- Grant each service only the secrets it needs.
- Rotate exposed or potentially compromised secrets immediately; maintain a documented rotation process.
- Never print secrets in logs, error reports, screenshots, or support messages.
- Do not invent custom cryptography. Use well-maintained, standard cryptographic libraries and protocols.
- Protect signing keys with strict access controls, audit logs, and separation from the public application server where feasible.
- Have a key-compromise response plan, including revocation, rotation, and user communication where necessary.

---

## 10. Logging, monitoring, and alerts

Log enough to investigate security incidents, but do not turn logs into a second database of sensitive information.

- Record authentication failures, permission denials, rate-limit events, suspicious financial activity, configuration changes, and admin actions.
- Use internal account references where possible instead of copying personal data into logs.
- Never log passwords, bot tokens, API keys, session tokens, private keys, seed phrases, full authorization headers, or complete payment payloads.
- Redact sensitive fields before sending logs to third-party monitoring services.
- Restrict log access and define a retention period.
- Alert on unusual withdrawal patterns, repeated failures, unexpected admin actions, ledger mismatches, and secret/configuration changes.
- Synchronize server clocks and use consistent timestamps.
- Protect audit logs from unauthorized modification and deletion.
- Test alerts so that they reach a responsible person and have a documented response process.

---

## 11. Infrastructure and deployment

- Keep operating systems, runtimes, frameworks, dependencies, and container images patched.
- Separate development, staging, and production environments.
- Use a production-only configuration and disable debug mode.
- Restrict deployment permissions and protect the main branch with review and automated checks.
- Scan dependencies and source code for known vulnerabilities and leaked secrets.
- Apply appropriate WAF, DDoS protection, and rate limiting.
- Minimize exposed ports and public services.
- Use secure DNS and TLS configuration.
- Maintain encrypted backups and periodically test recovery.
- Document deployment, rollback, incident response, and secret-rotation procedures.
- Do not deploy unreviewed code directly to a production system that handles funds.

---

## 12. Abuse and fraud prevention

- Apply reasonable per-account limits to deposits, withdrawals, referrals, rewards, and other abuse-prone actions.
- Calculate referral eligibility and rewards on the backend.
- Prevent self-referrals, duplicate claims, replayed requests, and race-condition exploits.
- Use cooldowns and review queues for suspicious activity.
- Do not rely on IP address alone to identify a person; shared networks and VPNs can cause false positives.
- Provide a way to review and appeal account restrictions where appropriate.
- Keep fraud signals proportionate and retain them only as long as needed.

---

## 13. Incident response

Prepare a written plan before an incident occurs.

1. **Contain:** Pause affected operations (especially withdrawals), restrict compromised accounts, and revoke suspicious sessions.
2. **Preserve:** Secure relevant logs and evidence without exposing additional user data.
3. **Assess:** Determine affected systems, data, users, transactions, and the likely entry point.
4. **Rotate:** Revoke and replace compromised credentials, API keys, bot tokens, and signing keys as applicable.
5. **Recover:** Patch the root cause, restore from trusted backups if needed, and verify ledger integrity before resuming operations.
6. **Notify:** Inform affected users, providers, and relevant authorities when required by applicable law or contractual obligations.
7. **Review:** Document the timeline, impact, remediation, and preventive actions.

Do not delete logs or make unverified public claims during an incident.

---

## 14. Security testing before release

- Test authentication bypass, account takeover, IDOR, privilege escalation, and session expiry.
- Test SQL injection, XSS, CSRF where applicable, and malicious input handling.
- Test rate limits, brute-force controls, and denial-of-service resilience.
- Test duplicate webhook delivery, replayed requests, concurrent withdrawals, and double-credit scenarios.
- Test incorrect network, token, destination, amount, and confirmation states.
- Verify that users cannot read or change another user's data.
- Verify that admin-only actions are inaccessible to ordinary users.
- Check frontend bundles, source maps, logs, and repositories for exposed secrets.
- Test backup restoration and emergency pause procedures.
- Conduct an independent security review or penetration test before handling significant funds and after major architectural changes.

---

## 15. Release gate

Do not release a build that handles real funds unless all applicable items below are complete:

- [ ] Telegram authentication is verified on the backend.
- [ ] Authorization is checked on every protected endpoint.
- [ ] No privileged secrets are exposed to clients or source control.
- [ ] Database access policies and permissions have been tested.
- [ ] Financial operations are atomic, idempotent, and auditable.
- [ ] Deposits and withdrawals are independently verified and protected.
- [ ] Admin access uses MFA and least privilege.
- [ ] Rate limiting and abuse controls are active.
- [ ] Logs redact secrets and have documented retention.
- [ ] Backups and restoration have been tested.
- [ ] Monitoring, alerts, and incident response are operational.
- [ ] Critical and high-severity security findings are resolved or formally mitigated.
- [ ] Privacy notices and retention practices accurately describe actual data handling.

---

## 16. Implementation rule for developers and AI coding agents

When adding or modifying any feature:

1. Identify what data the feature truly needs.
2. Prefer not to collect or store data if the feature can work without it.
3. If storage is necessary, define its purpose, access rules, and deletion/retention period.
4. Validate identity, authorization, and input on the backend.
5. Keep financial and privileged logic server-side.
6. Add tests for unauthorized access, duplicate requests, and failure cases.
7. Update this document when the security architecture or data collected changes.
8. Never weaken a security control merely to make a feature easier to implement.
9. Do not claim a feature is secure unless its controls have been implemented and tested.
10. If requirements conflict or are unclear, choose the safer default and document the trade-off.

**Default decision:** collect less, expose less, trust the client less, grant fewer permissions, and make sensitive actions auditable.
