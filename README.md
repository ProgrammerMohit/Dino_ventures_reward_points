# Internal Wallet Service

A production-grade internal wallet service for a gaming/loyalty rewards platform. Built with a **double-entry ledger architecture** to ensure data integrity, auditability, and correctness even under high concurrency and system failures.

---

## Table of Contents

- [Quick Start (Docker)](#quick-start-docker)
- [Quick Start (Manual)](#quick-start-manual)
- [API Reference](#api-reference)
- [Technology Choices](#technology-choices)
- [Architecture: Double-Entry Ledger](#architecture-double-entry-ledger)
- [Concurrency Strategy](#concurrency-strategy)
- [Deadlock Avoidance](#deadlock-avoidance)
- [Idempotency](#idempotency)
- [Schema Design](#schema-design)

---

## Quick Start (Docker)

The fastest way to run everything. This command spins up PostgreSQL, applies the schema migration, seeds the database, and starts the API server.

```bash
# 1. Clone and enter the project
git clone <repo-url> && cd wallet-service

# 2. Launch all services
docker-compose up --build

# 3. Verify the service is healthy
curl http://localhost:3000/health
```

The `migrate` service runs automatically before the app starts and applies both the schema (`001_schema.sql`) and the seed data (`002_seed.sql`).

---

## Quick Start (Manual)

### Prerequisites

- Node.js 20+
- PostgreSQL 14+

### Steps

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your PostgreSQL credentials

# 3. Create the database
psql -U postgres -c "CREATE DATABASE wallet_service;"

# 4. Apply schema migration
node scripts/migrate.js

# 5. Seed initial data
node scripts/seed.js

# 6. Start the server
npm start
# or for development with hot-reload:
npm run dev
```

### Run Tests

```bash
# Create a test database first
psql -U postgres -c "CREATE DATABASE wallet_service_test;"
DB_NAME=wallet_service_test node scripts/migrate.js
DB_NAME=wallet_service_test node scripts/seed.js

# Run tests
DB_NAME=wallet_service_test npm test
```

---

## API Reference

All endpoints are prefixed with `/api/v1/wallet`.

### `POST /topup` — Wallet Top-Up

Credits a user's wallet. Represents a user purchasing credits with real money (assumes payment gateway has already confirmed payment).

```json
POST /api/v1/wallet/topup
Content-Type: application/json

{
  "accountId":   "c1000000-0000-0000-0000-000000000001",
  "amount":      100,
  "referenceId": "payment-gateway-txn-abc123",
  "description": "Purchased 100 Gold Coins",
  "metadata":    { "paymentMethod": "credit_card" }
}
```

**Response `201 Created`:**
```json
{
  "success": true,
  "data": {
    "transactionId": "uuid",
    "referenceId":   "payment-gateway-txn-abc123",
    "type":          "TOP_UP",
    "accountId":     "c1000000-...",
    "amount":        100,
    "balanceAfter":  600,
    "createdAt":     "2025-01-01T00:00:00.000Z"
  }
}
```

---

### `POST /bonus` — Issue Bonus Credits

Issues free credits to a user (referral bonus, promotional reward, etc.).

```json
POST /api/v1/wallet/bonus

{
  "accountId":   "c1000000-0000-0000-0000-000000000002",
  "amount":      50,
  "referenceId": "referral-bonus-user-bob-jan-2025",
  "description": "Referral bonus for inviting a friend"
}
```

---

### `POST /spend` — Spend Credits

Deducts credits from a user's wallet. Returns `422` if balance is insufficient.

```json
POST /api/v1/wallet/spend

{
  "accountId":   "c1000000-0000-0000-0000-000000000001",
  "amount":      30,
  "referenceId": "purchase-item-sword-order-789",
  "description": "Purchased Legendary Sword"
}
```

---

### `GET /balance/:accountId` — Get Balance

```
GET /api/v1/wallet/balance/c1000000-0000-0000-0000-000000000001
```

**Response:**
```json
{
  "success": true,
  "data": {
    "accountId":  "c1000000-...",
    "name":       "Alice",
    "balance":    570,
    "asset":      { "code": "GOLD_COINS", "name": "Gold Coins" },
    "updatedAt":  "2025-01-01T00:00:00.000Z"
  }
}
```

---

### `GET /history/:accountId` — Transaction History

```
GET /api/v1/wallet/history/c1000000-...-001?limit=10&offset=0&type=SPEND
```

Query params: `limit` (1–100), `offset`, `type` (`TOP_UP` | `BONUS` | `SPEND`)

---

### `GET /accounts` — List Accounts (Admin)

```
GET /api/v1/wallet/accounts?accountType=USER&assetCode=GOLD_COINS
```

---

### `GET /audit/:accountId` — Ledger Integrity Check (Admin)

Compares the materialized balance cache against the full ledger sum. Returns `isConsistent: true` if they match.

```
GET /api/v1/wallet/audit/c1000000-0000-0000-0000-000000000001
```

---

### `GET /health` — Health Check

```
GET /health
```

---

## Technology Choices

### Node.js + Express

- **Why:** Excellent for I/O-bound services like this (database-heavy workloads). The async/await model handles concurrent requests efficiently without blocking threads.
- **Why not Go/Rust:** The assignment's core complexity is in database transaction logic, not CPU-bound computation. Node.js is pragmatic, widely understood, and has excellent PostgreSQL client libraries.

### PostgreSQL

- **Why:** The gold standard for ACID-compliant relational databases. Its `SERIALIZABLE` isolation level uses **Serializable Snapshot Isolation (SSI)** — a lock-free mechanism that provides full isolation without traditional locking deadlocks. This is crucial for financial data.
- **Why not MySQL/SQLite:** PostgreSQL's SSI implementation is superior to MySQL's locking-based serializable mode. SQLite is not suitable for high-concurrency multi-process deployments.

### `pg` (node-postgres)

- **Why:** The most battle-tested PostgreSQL client for Node.js. Direct SQL gives us full control over query planning, index hints, and transaction boundaries — essential when crafting fine-grained financial transactions.
- **Why not an ORM:** ORMs abstract away transaction control in ways that make it difficult to implement precise double-entry ledger logic. Raw SQL ensures we never have an accidental implicit transaction or missed `FOR UPDATE` lock.

---

## Architecture: Double-Entry Ledger

This service implements a **double-entry bookkeeping system**, the same principle used by every bank, payment processor, and accounting system since the 15th century.

### The Core Principle

Every credit movement involves **exactly two ledger entries** that sum to zero:

```
User Top-Up of 100 Gold Coins:

  Account             | Amount  | Balance After
  --------------------|---------|---------------
  Treasury            | +100    | (decreases)   ← DEBIT  (funds leave treasury)
  Alice's Wallet      | -100    | 600           ← CREDIT (funds arrive at Alice)
                      |  ∑ = 0  |               ← Invariant: always balances!
```

**Why this matters:**
- **Auditability:** Every coin that exists can be traced from its origin (treasury issuance) through every hand it passed through.
- **No money creation/destruction bugs:** If a transaction partially fails, the debit-without-credit is caught by the database rollback. Coins can't appear or disappear.
- **Reconciliation:** To verify system health, sum all ledger entries for every account. It must equal zero.

### The Three Flows

```
FLOW 1 — TOP_UP:   Treasury ──────────────────────► User Wallet
FLOW 2 — BONUS:    Bonus Pool ─────────────────────► User Wallet
FLOW 3 — SPEND:    User Wallet ────────────────────► Revenue Account
```

### Balance Calculation

A user's balance is the **negative sum** of all their ledger entries (because credit entries are stored as negative numbers):

```sql
-- Source of truth (ledger scan):
SELECT -SUM(amount) AS balance
FROM ledger_entries
WHERE account_id = $1;

-- Fast path (materialized cache):
SELECT balance FROM account_balances WHERE account_id = $1;
```

We maintain both. The cache is updated atomically within each transaction. The `GET /audit/:accountId` endpoint verifies they match.

---

## Concurrency Strategy

High-traffic scenarios (e.g., 1000 concurrent top-ups for the same user) require careful concurrency control.

### Primary Mechanism: `SELECT FOR UPDATE` + `SERIALIZABLE` Isolation

When processing any transaction, we lock the `account_balances` rows for all involved accounts **before** reading their balances:

```sql
SELECT a.*, ab.balance, ab.version
FROM accounts a
JOIN account_balances ab ON ab.account_id = a.id
WHERE a.id = ANY($1::uuid[])
ORDER BY a.id ASC          -- ← Key: consistent lock order (see deadlock section)
FOR UPDATE OF ab;          -- ← Exclusive row lock on balance rows
```

This means:
1. **Two concurrent transactions cannot both read and modify the same balance simultaneously.** The second one blocks until the first commits or rolls back.
2. Combined with `SERIALIZABLE` isolation, PostgreSQL's SSI detects any anomalies (phantom reads, write skew) and raises a serialization error that we transparently retry.

### Why Not Optimistic Locking?

Optimistic locking (`WHERE version = $old_version`) is fine for low-conflict scenarios but degrades under high contention — every conflict results in a retry of the full business logic. For a hot account (e.g., a treasury that every top-up touches), pessimistic locking with `FOR UPDATE` is more efficient because waiters queue at the database level rather than re-executing application code.

### Retry Logic

The `withTransaction()` wrapper automatically retries on:
- `40001` — Serialization failure (SSI conflict detected)
- `40P01` — Deadlock detected (belt-and-suspenders; our lock ordering prevents this, but we handle it anyway)

Retries use **exponential backoff with jitter** to prevent thundering herd:

```js
const delay = Math.min(50 * Math.pow(2, attempt) + Math.random() * 50, 2000);
```

---

## Deadlock Avoidance

Deadlocks occur when Tx1 holds lock on A and waits for B, while Tx2 holds B and waits for A.

**Our solution: Always acquire locks in a consistent, canonical order.**

When a transaction involves multiple accounts (e.g., user + treasury), we **sort the account UUIDs lexicographically** before locking them:

```js
const sortedIds = [...new Set(accountIds)].sort();
// ORDER BY a.id ASC in the SQL ensures PostgreSQL returns them in sorted order
```

This guarantees that any two concurrent transactions involving the same two accounts will always try to acquire locks in the **same order**, making deadlock structurally impossible for our access patterns.

> This is the **canonical lock ordering** technique — a standard pattern in database engineering for deadlock prevention.

---

## Idempotency

Every mutating endpoint requires a caller-provided `referenceId`. This is the **idempotency key**.

### How It Works

1. At the start of every transaction, we query the `idempotency_keys` table for the given `referenceId`.
2. If found (and not expired), we return the **exact same response** that was returned the first time — **without executing any database writes**.
3. If not found, we process normally and store the result before committing.

```sql
-- Check
SELECT response_status, response_body
FROM idempotency_keys
WHERE key = $1 AND expires_at > NOW();

-- Store (after successful processing, within same transaction)
INSERT INTO idempotency_keys (key, response_status, response_body)
VALUES ($1, $2, $3)
ON CONFLICT (key) DO NOTHING;
```

### Why This Matters

Without idempotency, a network timeout on a top-up request could cause the client to retry, resulting in the user being charged twice. With idempotency keys, retrying the exact same request is always safe — it returns the original result without any side effects.

Keys expire after 24 hours (configurable). The response includes `"idempotent": true` so callers can distinguish replays from fresh executions.

---

## Schema Design

```
asset_types          — Gold Coins, Diamonds, Loyalty Points
accounts             — User wallets and system accounts (Treasury, Revenue, Bonus Pool)
account_balances     — Materialized balance cache (updated atomically with each transaction)
transactions         — Top-level business events (TOP_UP, BONUS, SPEND)
ledger_entries       — Immutable double-entry accounting records
idempotency_keys     — Stores processed request results for safe retries
```

### Key Design Decisions

- **`account_balances` is a cache, not the source of truth.** The ledger is. This gives us fast O(1) balance reads without sacrificing auditability.
- **Ledger entries are immutable.** We never `UPDATE` or `DELETE` ledger entries. To reverse a transaction, we post a compensating entry (a debit where there was a credit, and vice versa). This preserves the full audit trail.
- **`version` column on `account_balances`** is a monotonic counter that increments with every balance change. Useful for debugging and detecting concurrent writes.
- **System accounts can go negative** — they represent the "infinite supply" from which all credits originate. User accounts can never go negative (enforced at the application layer before any database writes).

---

## Seeded Test Data

| Account           | Type   | Asset       | Initial Balance |
|-------------------|--------|-------------|-----------------|
| Alice             | USER   | Gold Coins  | 500             |
| Bob               | USER   | Gold Coins  | 200             |
| Charlie           | USER   | Diamonds    | 150             |
| Gold Treasury     | SYSTEM | Gold Coins  | —               |
| Diamonds Treasury | SYSTEM | Diamonds    | —               |
| Gold Revenue      | SYSTEM | Gold Coins  | —               |
| Gold Bonus Pool   | SYSTEM | Gold Coins  | —               |

Account IDs for direct API testing:
- Alice:   `c1000000-0000-0000-0000-000000000001`
- Bob:     `c1000000-0000-0000-0000-000000000002`
- Charlie: `c1000000-0000-0000-0000-000000000003`
