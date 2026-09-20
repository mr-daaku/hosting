# xStris — Full Telegram Crypto Wallet Bot Specification for Lovable

## 1. Project Identity

Build a production-ready Telegram custodial crypto wallet bot named:

- **Bot name:** xStris
- **Telegram username:** @xStrisBot
- **Admin Telegram ID:** 7206619137
- **Admin panel:** Telegram bot only
- **Public website:** Public read-only desktop dashboard only
- **Trading/exchange:** NOT included in the first version
- **Bot architecture:** Webhook-based, not long polling
- **Database:** Supabase/PostgreSQL
- **Frontend:** Public desktop dashboard
- **Backend:** Supabase Edge Functions / server-side functions as appropriate
- **Wallet architecture:** Server-side custodial HD wallet architecture
- **Important:** Never expose private keys, seed phrases, service-role/secret keys, RPC API keys, or bot tokens to the browser.

The UI/feature behavior should be inspired by the attached xRocket screenshots, but **do not copy xRocket branding, source code, copyrighted assets, or exact visual identity**. Create an original xStris design.

---

# 2. CRITICAL SECURITY REQUIREMENT

The Telegram bot token supplied during development must NOT be hardcoded into source code, SQL, frontend code, Git, or this prompt.

Create this environment/secret variable:

```env
TELEGRAM_BOT_TOKEN=
```

The actual bot token should be entered later through Lovable/Supabase secret management.

The admin ID can be configured as:

```env
TELEGRAM_ADMIN_ID=7206619137
```

Use Telegram's webhook system. The webhook endpoint must validate Telegram's secret token/header and reject unauthorized requests.

Telegram's official Bot API supports `setWebhook`, HTTPS webhook URLs, secret tokens, and webhook request headers. Use that model rather than polling.

---

# 3. ENVIRONMENT VARIABLES

Create a `.env.example` containing placeholders only.

## Telegram

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_ADMIN_ID=7206619137
TELEGRAM_WEBHOOK_URL=
TELEGRAM_WEBHOOK_SECRET=
```

## Supabase

Support the modern Supabase configuration:

```env
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
SUPABASE_PROJECT_ID=
```

For compatibility with existing code, optionally support:

```env
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

Prefer modern publishable/secret keys for new implementation.

## Blockchain RPC

```env
EVM_ETH_RPC_URL=
EVM_BSC_RPC_URL=
EVM_POLYGON_RPC_URL=
EVM_BASE_RPC_URL=
EVM_ARBITRUM_RPC_URL=

TRON_RPC_URL=
TRON_API_KEY=

BTC_RPC_URL=

TON_RPC_URL=
TON_API_KEY=

SOLANA_RPC_URL=
```

Do not hardcode RPC providers into application logic. Admin must be able to configure/update RPC endpoints and API keys from the Telegram admin panel.

---

# 4. FREE / OPEN PUBLIC API REQUIREMENT

The first version should be designed around free/open/public RPC/API providers wherever technically possible.

Do NOT require a paid API subscription to run the basic system.

However:

- Providers can rate-limit public RPCs.
- Build a provider abstraction layer.
- Allow multiple RPC endpoints per network.
- Allow admin to add/remove/change RPC endpoints.
- Add fallback RPC support.
- Never put RPC API keys in frontend code.
- Never expose admin RPC configuration publicly.

Networks:

### EVM
- Ethereum
- BNB Smart Chain
- Polygon
- Base
- Arbitrum

### TRON
- TRON mainnet

### Bitcoin
- Bitcoin mainnet

### TON
- The Open Network

### Solana
- Solana mainnet

The wallet engine must not assume that one RPC provider works forever. RPC configuration must be dynamic.

---

# 5. SUPPORTED COINS / ASSETS

Initial supported native coins/assets:

- USDT
- USDC
- BTC
- ETH
- BNB
- TRX
- TON
- SOL

The UI must display **coin names only**.

Do NOT use coin emojis/icons in the first version.

Examples:

```text
USDT
USDC
BTC
ETH
BNB
TRX
TON
SOL
```

No:

```text
💎 USDT
₿ BTC
💰 BNB
```

unless explicitly enabled later.

For token assets, store:

- symbol
- name
- network
- contract/mint address
- decimals
- minimum deposit
- minimum withdrawal
- withdrawal fee
- enabled/disabled status

Do not hardcode token contract addresses throughout the code. Store them in the database/configuration layer.

---

# 6. SUPPORTED NETWORKS

Show networks clearly:

```text
BNB Smart Chain (BEP20)
TRON (TRC20)
Ethereum (ERC20)
The Open Network (TON)
Solana (SOL)
Bitcoin
Polygon
Base
Arbitrum
```

Network selection must be asset-aware.

Example:

If user selects USDT:

```text
Select network for USDT

BNB Smart Chain (BEP20)
TRON (TRC20)
Ethereum (ERC20)
The Open Network (TON)
Solana (SOL)
```

Only show networks where that asset is configured.

---

# 7. USER REGISTRATION

When a user opens `/start`:

1. Read Telegram user ID.
2. Create user if not already present.
3. Store:
   - Telegram ID
   - username
   - first name
   - last name
   - language
   - created_at
   - last_seen_at
   - status
4. Allocate a unique HD wallet derivation index.
5. Generate/configure the user's supported wallet addresses.
6. Never generate duplicate indexes.
7. Use database transaction/locking/unique constraints.
8. Do not expose seed/private key material to the user.

User wallet model:

```text
Telegram User
    ↓
User wallet index
    ↓
Chain-specific derived addresses
    ↓
Deposit scanners
    ↓
Internal balance ledger
```

---

# 8. WALLET ARCHITECTURE

Use an HD-wallet architecture.

There should be one securely stored master wallet/seed/key hierarchy on the backend and deterministic user derivation indexes.

Do NOT store raw seed phrases/private keys in normal database columns.

If encrypted key material must be stored, encrypt it with a strong server-side secret/KMS-compatible design.

Never log:

- seed phrases
- private keys
- encrypted key material
- API secrets
- bot token

Use chain-specific derivation paths appropriate to the wallet library being used. Do not blindly assume one derivation path works for every chain.

---

# 9. MAIN BOT MENU

Create a Telegram inline-keyboard UI similar in functionality to the screenshots.

Main menu:

```text
Wallet
Deposit
Withdraw
Exchange
Swap
Buy/Sell
P2P Market
Pay via QR
Referrals
Pay API
Developers
Cheques
Invoices
Subscriptions
About xStris
Commands
Settings
Collapse menu
Open app
```

However, because trading/exchange is not included in V1:

- Exchange
- Swap
- Buy/Sell
- P2P Market

must either:
1. show "Coming soon", or
2. remain disabled/hidden behind configuration.

Do NOT implement fake trading.

---

# 10. WALLET SCREEN

Wallet screen should show the user's balances.

Example:

```text
My Wallet

USDT: 0.3705 USDT
USDC: 0
BTC: 0
ETH: 0
BNB: 0
TRX: 0
TON: 0
SOL: 0

≈ $0.82
```

Use real-time balance values from the internal ledger.

For fiat valuation:

- use configurable price APIs
- cache prices
- do not block wallet operations if price API is unavailable
- show "—" or last known value when price data is unavailable

Wallet actions:

```text
Total balance
Transfer between balances
Balance Settings
```

---

# 11. DEPOSIT FLOW

Menu:

```text
Deposit
```

Show supported assets:

```text
USDT
USDC
BTC
ETH
BNB
TRX
TON
SOL
```

After selecting an asset, show compatible networks.

Example:

```text
Select a deposit network for USDT:

BNB Smart Chain (BEP20)
TRON (TRC20)
Ethereum (ERC20)
The Open Network (TON)
Solana (SOL)
```

After selecting a network:

```text
Deposit — Main

Wallet address for depositing USDT via
BNB Smart Chain (BEP20):

0x....

Minimum deposit amount: 0.1 USDT

Contract address:
0x....

Only send USDT via BNB Smart Chain (BEP20)
to this address.

Funds sent through another method may be lost.
```

Buttons:

```text
Copy address
Show QR
My wallets
Back
```

Requirements:

- QR generation
- copy address button
- network name
- asset name
- minimum deposit
- contract address for tokens
- confirmation warning
- transaction detection
- confirmation tracking
- automatic credit after configured confirmations
- duplicate transaction protection

Never credit the same blockchain transaction/event twice.

---

# 12. WITHDRAW FLOW

Menu:

```text
Withdraw
```

Show user's available balances.

Example:

```text
Select the currency you want to withdraw:

USDT
USDC
BTC
ETH
BNB
TRX
TON
SOL
```

Then network selection.

Then ask:

```text
Enter destination address:
```

Then:

```text
Enter amount:
```

Display:

```text
Balance
Minimum
Fee
You will receive
```

Example:

```text
Withdraw

Network: BNB Smart Chain (BEP20)

Balance: 0.3705 USDT

Minimum: 0.000001 USDT

Fee: 1.5 USDT

You will receive: 0 USDT
```

If balance is insufficient:

```text
You do not have enough USDT to make this withdrawal.
```

Withdrawal system must support:

- address validation
- network validation
- amount validation
- minimum withdrawal
- fee calculation
- internal balance reservation
- withdrawal status
- blockchain transaction hash
- confirmation tracking
- retry handling
- idempotency
- admin controls
- audit logs

Use integer/base-unit accounting. Never use JavaScript floating-point arithmetic for balances.

---

# 13. INTERNAL TRANSFERS

Implement:

```text
Transfer between balances
```

Users should be able to transfer supported assets between their own internal balances/networks where logically supported.

Also prepare the architecture for:

```text
user → user
```

internal transfers later.

Internal transfers should not create unnecessary blockchain transactions.

Use a proper ledger.

---

# 14. INTERNAL LEDGER

Do NOT treat blockchain balances as the only database balance.

Create an internal accounting system.

Recommended conceptual tables:

```text
users
wallet_accounts
wallet_addresses
assets
networks
balances
ledger_accounts
ledger_entries
deposits
withdrawals
transactions
fees
prices
rpc_providers
api_keys
settings
audit_logs
```

For financial correctness, use double-entry or an equivalent auditable ledger.

Every balance-changing operation must create an immutable ledger record.

Never simply:

```sql
UPDATE balance = balance + amount
```

without an associated ledger entry.

---

# 15. TRANSACTION SYSTEM

Track:

```text
transaction_id
user_id
asset_id
network_id
type
amount
fee
status
tx_hash
from_address
to_address
confirmations
block_number
created_at
updated_at
```

Statuses:

```text
pending
processing
confirmed
failed
cancelled
reversed
```

Use unique constraints/idempotency based on chain transaction identifiers and event/log identifiers.

---

# 16. BLOCKCHAIN SCANNERS

Do not perform heavy blockchain scanning directly inside Telegram webhook handlers.

Create background jobs/workers for:

- EVM deposits
- TRON deposits
- Bitcoin deposits
- TON deposits
- Solana deposits
- confirmation tracking
- withdrawal monitoring
- price updates

The Telegram webhook should remain fast.

Architecture:

```text
Telegram
   ↓
Webhook
   ↓
Bot handlers
   ↓
Database / queue
   ↓
Workers
   ↓
Blockchain RPCs
```

---

# 17. PAY API

Create an xRocket-inspired developer payment API.

Menu:

```text
Pay API
```

Description:

```text
Integrate xStris Pay into your service and accept payments in cryptocurrency.

Create invoices and payment requests using the xStris Pay API.
```

Developer can create an application.

Example:

```text
App name: SpiderBoxHub

Balance: 0
Invoices: 0
```

Actions:

```text
Deposit
Withdraw
Settings
Delete App
Back
```

Each application should have:

```text
app_id
public identifier
secret/API key
webhook secret
created_at
status
```

API keys must only be displayed securely and should support regeneration/revocation.

---

# 18. INVOICES

Support:

```text
Single invoice
Multi invoice
```

Single invoice:

- one-time payment

Multi invoice:

- reusable payment request

Invoice fields:

```text
invoice_id
app_id
asset
network
amount
currency
description
status
expires_at
paid_at
tx_hash
callback/webhook status
```

Statuses:

```text
pending
paid
expired
cancelled
overpaid
underpaid
```

API should support:

```text
Create invoice
Get invoice
Cancel invoice
Check invoice
Webhook notification
```

Do not build a fake payment status. Payment status must be based on verified blockchain/internal ledger events.

---

# 19. WEBHOOKS FOR DEVELOPERS

Each developer application can configure:

```text
Webhook URL
Webhook Secret
```

Send events such as:

```text
invoice.created
invoice.paid
invoice.expired
withdrawal.created
withdrawal.confirmed
withdrawal.failed
```

Sign webhook requests with HMAC.

Include an event ID for idempotency.

Provide retry logic.

Store webhook delivery attempts.

---

# 20. CHEQUES

Implement xRocket-inspired cheque functionality.

Types:

```text
Personal cheque
Multi-cheque
Rocket cheque
Cheque Board
```

### Personal cheque

Send a claimable amount to another Telegram user.

### Multi-cheque

Allow multiple users to claim a configured amount.

### Rocket cheque

Prepare the architecture for reward/distribution cheques.

Do not overcomplicate V1.

Every cheque needs:

```text
cheque_id
creator_user_id
asset
amount
max_claims
claims_count
status
expires_at
created_at
```

Prevent double claims.

---

# 21. REFERRALS

Implement:

```text
Referrals
```

Generate a referral link:

```text
https://t.me/xStrisBot?start=ref_<code>
```

Store:

```text
referrer
referred_user
created_at
reward_status
```

Make referral rewards configurable from the admin panel.

Do not hardcode a reward percentage.

---

# 22. SUBSCRIPTIONS

Create the initial data model and basic flow for:

```text
Subscriptions
```

A subscription can contain:

```text
merchant/app
asset
network
amount
interval
next_payment_at
status
subscriber
```

Automated recurring blockchain payments must NOT be falsely claimed as possible if the selected blockchain cannot support them in the intended way.

V1 can provide the data model and manual/payment-request flow.

---

# 23. QR PAYMENTS

Implement QR generation for:

- wallet addresses
- invoices
- payment requests

QR should encode the appropriate blockchain payment URI/address format where supported.

---

# 24. SETTINGS

User settings should include:

```text
Support
Balance Settings
Token Management
Privileges
Bot Language
Bot Currency
History of Actions
Jetton/Token Listing Application
Exchange Settings
Connect Wallet
Groups Management
Limits and Fees
Back
```

Features not implemented in V1 should show:

```text
Coming soon
```

Do not create fake controls.

---

# 25. TOKEN MANAGEMENT

Allow admin-configured tokens/assets.

Admin should be able to add:

```text
Token name
Symbol
Network
Contract address / mint address
Decimals
Deposit enabled
Withdrawal enabled
Minimum deposit
Minimum withdrawal
Withdrawal fee
Price source
Status
```

The normal user UI should show the **name/symbol only**, without coin emojis.

---

# 26. USER HISTORY

Create:

```text
History of actions
```

Show:

```text
Deposits
Withdrawals
Transfers
Invoices
Payments
Cheques
Referrals
```

Allow pagination.

---

# 27. LIMITS AND FEES

All limits and fees must be configurable.

Per asset/network:

```text
minimum_deposit
minimum_withdrawal
withdrawal_fee
daily_limit
monthly_limit
confirmation_count
```

Admin can change these from Telegram.

Changes must be written to an audit log.

---

# 28. ADMIN PANEL — TELEGRAM ONLY

IMPORTANT:

There must be NO public browser admin dashboard.

The entire administrative control system must operate through the Telegram bot.

Only:

```text
TELEGRAM_ADMIN_ID=7206619137
```

can access admin commands/menu.

Every admin action must check Telegram user ID server-side.

Never rely on frontend/UI hiding.

Admin panel should include:

```text
Admin Dashboard
Users
Wallets
Balances
Deposits
Withdrawals
Transactions
Assets
Networks
RPC Providers
API Keys
Fees
Limits
Invoices
Developer Apps
Cheques
Referrals
Subscriptions
Webhooks
System Settings
Audit Logs
Bot Statistics
Health
```

---

# 29. ADMIN DASHBOARD STATISTICS

The admin Telegram panel should show:

```text
Total Users
Active Users
New Users Today
Total Wallets
Total Transactions
Pending Transactions
Confirmed Transactions
Failed Transactions
Total Deposits
Total Withdrawals
Total Internal Transfers
Total Invoice Volume
Total Fees
Developer Apps
Pending Withdrawals
RPC Health
Webhook Health
```

Use real database values.

---

# 30. ADMIN USER MANAGEMENT

Admin can:

```text
Search user
View user
View balances
View wallet addresses
View transactions
View deposits
View withdrawals
Freeze user
Unfreeze user
Set limits
View referral data
View audit history
```

Do not allow dangerous actions without confirmation.

For financial actions use:

```text
Confirm
Cancel
```

and optionally require a second confirmation for high-risk operations.

---

# 31. ADMIN ASSET MANAGEMENT

Admin can:

```text
Add asset
Edit asset
Disable asset
Enable asset
Set minimum deposit
Set minimum withdrawal
Set withdrawal fee
Set confirmation count
Set contract address
Set decimals
Set price source
```

---

# 32. ADMIN RPC MANAGEMENT

Admin can configure RPCs through Telegram.

Example:

```text
Ethereum RPC
BSC RPC
Polygon RPC
Base RPC
Arbitrum RPC
TRON RPC
Bitcoin RPC
TON RPC
Solana RPC
```

Admin actions:

```text
Add RPC
Remove RPC
Enable RPC
Disable RPC
Set priority
Test RPC
View latency
View health
```

API keys must be masked in UI:

```text
sk_live_************1234
```

Never display the full secret after saving unless explicitly implementing a secure one-time reveal.

---

# 33. PUBLIC WEBSITE / DESKTOP DASHBOARD

The website is PUBLIC.

It is NOT an admin panel.

It should show a desktop-style public dashboard/landing experience for xStris.

No login required for the public statistics page.

Show public statistics such as:

```text
Total Users
Total Transactions
Total Volume
Supported Assets
Supported Networks
Total Wallets
Developer Apps
```

Only show aggregated statistics.

Never expose:

- user Telegram IDs
- wallet private keys
- private addresses linked to users
- API keys
- RPC URLs if they contain secrets
- bot token
- admin information
- internal database IDs
- private transactions

The public site should be responsive, but its primary design target is a desktop dashboard.

---

# 34. PUBLIC WEBSITE DESIGN

Create a premium dark crypto-fintech interface.

Preferred visual direction:

- black/dark background
- white typography
- premium purple/blue highlights
- subtle gradients
- glassmorphism
- thin borders
- clean cards
- modern dashboard
- professional spacing
- smooth animations
- no excessive neon
- no random crypto emojis
- no copied xRocket assets

Brand:

```text
xStris
```

Use a clean text-based logo/wordmark.

---

# 35. TELEGRAM BOT UI DESIGN

The Telegram interface should feel polished and similar in information architecture to the supplied screenshots:

- dark message cards
- compact inline keyboards
- clear sections
- consistent Back buttons
- Open App button
- confirmation screens
- clear warning messages
- no unnecessary emojis for coins

Use text labels such as:

```text
USDT
BTC
ETH
BNB
TRX
TON
SOL
```

instead of:

```text
💎 USDT
₿ BTC
```

---

# 36. OPEN APP

Add:

```text
Open app
```

button where useful.

It should open the public xStris web application.

Do not make the public web app an admin dashboard.

---

# 37. BOT WEBHOOK ARCHITECTURE

Use Telegram webhook, not polling.

Concept:

```text
Telegram
   ↓ HTTPS POST
/api/telegram/webhook
   ↓
Validate Telegram secret token
   ↓
Process update
   ↓
Bot handler
   ↓
Supabase
   ↓
Queue/background worker if needed
```

The webhook must return quickly.

Heavy blockchain work must be asynchronous.

Use idempotency for Telegram update IDs.

---

# 38. DATABASE SCHEMA

Create a normalized PostgreSQL schema.

Minimum tables:

```text
users
user_settings
wallet_accounts
wallet_addresses
assets
networks
asset_networks
balances
ledger_accounts
ledger_entries
deposits
withdrawals
blockchain_transactions
internal_transfers
rpc_providers
rpc_health_checks
developer_apps
developer_api_keys
developer_webhooks
invoices
invoice_payments
cheques
cheque_claims
referrals
subscriptions
fees
limits
prices
webhook_deliveries
admin_settings
audit_logs
system_events
```

Add:

- UUID primary keys where appropriate
- Telegram IDs as BIGINT
- unique constraints
- foreign keys
- timestamps
- indexes
- status fields
- check constraints
- idempotency keys

---

# 39. DATABASE SECURITY

Enable Supabase Row Level Security where applicable.

The public website should only access safe aggregated/public data.

Admin operations must run server-side.

Never expose Supabase secret/service-role credentials to the browser.

Use server-side functions for privileged operations.

---

# 40. API SECURITY

Protect:

- admin endpoints
- developer API endpoints
- Telegram webhook
- developer webhooks
- RPC configuration
- wallet operations

Use:

- authentication
- authorization
- rate limiting
- validation
- idempotency
- audit logging
- HMAC where appropriate

Use Zod or equivalent schema validation.

---

# 41. BLOCKCHAIN DATA PROVIDER ABSTRACTION

Create a common interface:

```ts
BlockchainProvider
```

with operations conceptually like:

```ts
getBalance()
getTokenBalance()
validateAddress()
getTransaction()
getBlock()
broadcastTransaction()
getTransactionStatus()
scanDeposits()
estimateFee()
```

Then implement chain-specific providers:

```text
EVMProvider
TRONProvider
BitcoinProvider
TONProvider
SolanaProvider
```

Do not couple Telegram handlers directly to RPC SDKs.

---

# 42. WORKER / JOB SYSTEM

Use background jobs for:

```text
deposit scanning
withdrawal broadcasting
confirmation checks
price updates
RPC health checks
webhook retries
subscription checks
cleanup
```

If Redis/BullMQ or another queue is used, keep it configurable.

Do not make the entire bot depend on a queue for simple Telegram replies.

---

# 43. ERROR HANDLING

User-facing errors must be simple.

Example:

```text
Something went wrong.
Please try again later.
```

Developer/admin logs can contain detailed diagnostics.

Never send stack traces to Telegram users.

Never log secrets.

---

# 44. TRANSACTION SAFETY

Every financial operation must be atomic.

Examples:

Deposit:

```text
Blockchain confirmation
      ↓
Verify transaction
      ↓
Idempotency check
      ↓
Ledger credit
      ↓
Balance update
      ↓
Record transaction
      ↓
Notify user
```

Withdrawal:

```text
Validate request
      ↓
Check available balance
      ↓
Reserve funds
      ↓
Create withdrawal
      ↓
Worker broadcasts
      ↓
Store tx hash
      ↓
Wait confirmations
      ↓
Finalize ledger
      ↓
Notify user
```

Do not allow double spending through concurrent requests.

Use database transactions and row locks where required.

---

# 45. PRICE DATA

Create a price-provider abstraction.

Support free public price APIs where possible.

Price data must be:

- cached
- rate-limit aware
- optional
- never required for blockchain transfers

Admin should be able to configure price providers later.

---

# 46. LOGGING / MONITORING

Create structured logs.

Track:

```text
Telegram update processing
RPC calls
RPC failures
database errors
deposit scans
withdrawals
webhook deliveries
API requests
admin actions
```

Never log secrets.

---

# 47. TESTING

Create tests for:

- wallet index allocation
- duplicate user prevention
- balance calculations
- ledger entries
- deposits
- withdrawals
- address validation
- invoice lifecycle
- cheque claims
- referral tracking
- webhook authentication
- admin authorization
- RPC failover
- idempotency
- concurrent withdrawal requests

Add integration tests where practical.

---

# 48. PROJECT STRUCTURE

Use a clean architecture similar to:

```text
xstris/
├── src/
│   ├── bot/
│   │   ├── handlers/
│   │   ├── keyboards/
│   │   ├── messages/
│   │   └── middleware/
│   │
│   ├── api/
│   │   ├── routes/
│   │   └── middleware/
│   │
│   ├── blockchain/
│   │   ├── evm/
│   │   ├── tron/
│   │   ├── bitcoin/
│   │   ├── ton/
│   │   └── solana/
│   │
│   ├── wallet/
│   ├── ledger/
│   ├── invoices/
│   ├── cheques/
│   ├── referrals/
│   ├── providers/
│   ├── workers/
│   ├── services/
│   ├── config/
│   └── utils/
│
├── supabase/
│   ├── migrations/
│   └── functions/
│
├── public/
├── tests/
├── .env.example
├── .gitignore
└── README.md
```

Adapt this structure to Lovable's generated architecture when necessary, but keep the separation of concerns.

---

# 49. DOCKER / DEPLOYMENT

Make the project portable.

Create Docker support where compatible with the selected Lovable/Supabase architecture.

Use:

```text
Dockerfile
compose.yaml
.env.example
```

Do not bake secrets into Docker images.

Production secrets must come from environment/secret management.

The app should work consistently between local development and deployment.

---

# 50. ADMIN-ONLY TELEGRAM COMMANDS

Prepare commands such as:

```text
/admin
/stats
/users
/user <telegram_id>
/withdrawals
/deposits
/transactions
/assets
/networks
/rpc
/fees
/limits
/apps
/invoices
/audit
/health
```

All must verify:

```text
telegram_user_id === 7206619137
```

server-side.

---

# 51. NORMAL USER COMMANDS

Prepare:

```text
/start
/wallet
/deposit
/withdraw
/history
/referrals
/settings
/help
```

Inline keyboards should be preferred for the main user experience.

---

# 52. V1 SCOPE

V1 MUST include:

- Telegram bot
- webhook
- user registration
- custodial wallet architecture
- supported asset configuration
- deposit flow
- withdrawal flow
- balance display
- internal ledger
- transaction history
- QR
- Pay API foundation
- invoices
- cheques foundation
- referrals
- user settings
- admin panel inside Telegram
- RPC management
- asset management
- fees/limits
- public desktop statistics dashboard
- Supabase database
- blockchain provider abstraction
- worker/background architecture
- security/audit logs

V1 MUST NOT include real trading/exchange functionality.

For:

```text
Exchange
Swap
Buy/Sell
P2P Market
```

show:

```text
Coming soon
```

or keep them disabled.

Do not simulate trades.

---

# 53. IMPORTANT PRODUCT RULE

Do not build a fake UI-only prototype.

The application must have real:

- database persistence
- Telegram webhook handling
- user records
- wallet records
- ledger
- transaction records
- configurable assets
- configurable RPC providers
- admin controls
- invoice records
- webhook delivery records

Where a blockchain integration cannot safely be completed during the first implementation, clearly isolate it behind an interface and mark the integration as pending instead of pretending it works.

---

# 54. LOVABLE IMPLEMENTATION INSTRUCTIONS

Build this as a complete application, not merely a landing page.

First create the database schema and backend/server functions.

Then implement the Telegram webhook.

Then implement wallet/account models.

Then implement deposit/withdrawal workflows.

Then implement the Telegram UI.

Then implement the public dashboard.

Then implement Pay API/invoices.

Then implement cheques/referrals.

Then implement admin controls.

After implementation:

1. Check all imports.
2. Check TypeScript errors.
3. Check database migrations.
4. Check RLS policies.
5. Check environment variables.
6. Check webhook security.
7. Check admin authorization.
8. Check mobile/desktop layout.
9. Test all Telegram callback buttons.
10. Test duplicate callbacks.
11. Test duplicate deposits.
12. Test concurrent withdrawal requests.
13. Test RPC failure handling.
14. Test public dashboard does not expose private data.

---

# 55. FINAL UX REQUIREMENT

The finished xStris experience should feel like a serious Telegram crypto wallet:

```text
xStris
Crypto wallet inside Telegram
```

Fast navigation.

Simple buttons.

Clear balances.

Clear deposit addresses.

Clear withdrawal fees.

Clear transaction statuses.

Strong security.

No unnecessary coin emojis.

No fake trading.

No public admin panel.

No exposed secrets.

The public website is only the public desktop dashboard/statistics experience.

All privileged management is performed through Telegram by the configured admin.

---

# 56. SECRET HANDLING REMINDER

The bot token and all API/RPC secrets must be entered through secret/environment configuration.

Never place them in:

- GitHub
- source code
- frontend bundle
- SQL migrations
- public website
- screenshots
- README
- logs
- browser localStorage

Use placeholders in `.env.example`.

Before production deployment, rotate any credential that was ever exposed in chat, source code, screenshots, or logs.

---

# 57. DEFINITION OF DONE

Do not consider the project complete until:

- `/start` works
- user is persisted in Supabase
- unique wallet index is allocated
- wallet addresses are persisted
- main menu works
- deposit flow works
- withdrawal flow validates correctly
- balances are backed by ledger data
- transactions are persisted
- webhook is secured
- admin panel works only for admin ID 7206619137
- RPC configuration can be managed by admin
- assets/networks can be managed by admin
- public dashboard shows safe aggregate statistics
- no secret is exposed to frontend
- V1 trading features remain disabled
- error handling works
- audit logs work
- tests cover financial-critical logic
- README explains setup, env vars, database migration, webhook setup, local development, and deployment

Build xStris as an original product inspired by the feature set shown in the supplied screenshots, not as a copy of xRocket.

very Important note - chahe kuch bhi ho jaye tum ye pura task ek bar me complete karoge aur ye rule ke under hai, quki mere pass bahut credit hai jo mene pro liya hai.
