-- Wallet Service Schema
-- Double-Entry Ledger Architecture

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ASSET TYPES
-- Defines the types of virtual currency in the system

CREATE TABLE IF NOT EXISTS asset_types (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code        VARCHAR(50) UNIQUE NOT NULL, -- e.g., 'GOLD_COINS'
    name        VARCHAR(100) NOT NULL,       -- e.g., 'Gold Coins'
    description TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- ACCOUNT TYPES
-- Distinguishes system accounts from user accounts

CREATE TYPE account_type AS ENUM ('SYSTEM', 'USER');


-- ACCOUNTS (Wallets)
-- Every entity that holds a balance gets an account.
-- Balance is NOT stored here — it is derived from the ledger.

CREATE TABLE IF NOT EXISTS accounts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    external_id     VARCHAR(255) UNIQUE, -- user ID from auth system
    account_type    account_type NOT NULL DEFAULT 'USER',
    name            VARCHAR(255) NOT NULL,
    asset_type_id   UUID NOT NULL REFERENCES asset_types(id),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accounts_external_id ON accounts(external_id);
CREATE INDEX IF NOT EXISTS idx_accounts_asset_type ON accounts(asset_type_id);

-- TRANSACTION TYPES
-- Defines the category of each top-level transaction

CREATE TYPE transaction_type AS ENUM (
    'TOP_UP',  -- User purchases credits (real money → credits)
    'BONUS',   -- System issues free credits (referral, promo)
    'SPEND'    -- User spends credits (credits → in-app item)
);


-- TRANSACTIONS
-- The top-level business event. One transaction can have
-- multiple ledger entries (the actual accounting).

CREATE TABLE IF NOT EXISTS transactions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    type            transaction_type NOT NULL,
    reference_id    VARCHAR(255) UNIQUE NOT NULL, -- External/idempotency key
    description     TEXT,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transactions_reference_id ON transactions(reference_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at);

-- LEDGER ENTRIES (Double-Entry)
-- Every financial movement is recorded as a DEBIT on one
-- account and a CREDIT on another. The sum of all entries
-- for any transaction must be ZERO (double-entry invariant).
--
-- Convention:
--   DEBIT  (+) = amount leaving the account  (positive value)
--   CREDIT (-) = amount entering the account (negative value)
--
-- Example: User tops up 100 Gold Coins
--   Treasury account: DEBIT  +100  (coins leave treasury)
--   User account:     CREDIT -100  (coins arrive at user)
--
-- A user's "balance" = SUM of all their ledger entries,
-- negated (because credits are stored negative).

CREATE TABLE IF NOT EXISTS ledger_entries (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transaction_id  UUID NOT NULL REFERENCES transactions(id),
    account_id      UUID NOT NULL REFERENCES accounts(id),
    asset_type_id   UUID NOT NULL REFERENCES asset_types(id),

    -- Positive = debit (funds leaving account)
    -- Negative = credit (funds entering account)
    amount          NUMERIC(20, 8) NOT NULL,

    -- Running balance snapshot for this account at time of entry
    -- Calculated and stored for fast balance lookups & auditing
    balance_after   NUMERIC(20, 8) NOT NULL,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_transaction ON ledger_entries(transaction_id);
CREATE INDEX IF NOT EXISTS idx_ledger_account_created ON ledger_entries(account_id, created_at DESC);

-- ACCOUNT BALANCES (Materialized Cache)
-- Stores the current balance to avoid full ledger scan.
-- Updated atomically with each transaction using SELECT FOR UPDATE.
-- Acts as a cache — source of truth is always the ledger.

CREATE TABLE IF NOT EXISTS account_balances (
    account_id      UUID PRIMARY KEY REFERENCES accounts(id),
    asset_type_id   UUID NOT NULL REFERENCES asset_types(id),
    balance         NUMERIC(20, 8) NOT NULL DEFAULT 0,
    version         BIGINT NOT NULL DEFAULT 0,    -- Optimistic lock version
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- IDEMPOTENCY KEYS
-- Prevents duplicate processing of the same request.
-- Stores the result of previously processed requests.

CREATE TABLE IF NOT EXISTS idempotency_keys (
    key             VARCHAR(255) PRIMARY KEY,
    response_status INT NOT NULL,
    response_body   JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours')
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);

-- DATABASE CONSTRAINTS


-- Ensure ledger entries always balance within a transaction
-- (Sum of all amounts per transaction must equal 0)
-- This is enforced at application level + can be added as a trigger

-- Ensure balances never go negative for user accounts
-- This is enforced at application level with SELECT FOR UPDATE


-- TRIGGER: Auto-update updated_at on accounts

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER accounts_updated_at
    BEFORE UPDATE ON accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER account_balances_updated_at
    BEFORE UPDATE ON account_balances
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();


-- FUNCTION: Verify ledger balance integrity
-- Can be called for auditing to verify cache == ledger sum

CREATE OR REPLACE FUNCTION verify_balance_integrity(p_account_id UUID)
RETURNS TABLE(
    cached_balance NUMERIC,
    ledger_balance NUMERIC,
    is_consistent BOOLEAN
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        ab.balance AS cached_balance,
        COALESCE(-SUM(le.amount), 0) AS ledger_balance,
        ABS(ab.balance - COALESCE(-SUM(le.amount), 0)) < 0.00000001 AS is_consistent
    FROM account_balances ab
    LEFT JOIN ledger_entries le ON le.account_id = ab.account_id
    WHERE ab.account_id = p_account_id
    GROUP BY ab.balance;
END;
$$ LANGUAGE plpgsql;
