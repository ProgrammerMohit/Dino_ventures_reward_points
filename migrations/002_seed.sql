-- SEED DATA for Wallet Service
-- Run this AFTER the schema migration (001_schema.sql)
-- 1. ASSET TYPES

INSERT INTO asset_types (id, code, name, description)
VALUES
    ('a1000000-0000-0000-0000-000000000001', 'GOLD_COINS',     'Gold Coins',     'Primary in-game currency earned and spent in the game'),
    ('a1000000-0000-0000-0000-000000000002', 'DIAMONDS',        'Diamonds',        'Premium currency purchased with real money'),
    ('a1000000-0000-0000-0000-000000000003', 'LOYALTY_POINTS',  'Loyalty Points',  'Points awarded for activity; redeemable for rewards')
ON CONFLICT (code) DO NOTHING;

-- 2. SYSTEM ACCOUNTS (Treasury / Revenue)
-- These are the counterparty for all transactions.
-- A top-up debits the Treasury; a spend credits it.

INSERT INTO accounts (id, external_id, account_type, name, asset_type_id)
VALUES
    -- Gold Coins Treasury (source/sink for all Gold Coin flows)
    ('b1000000-0000-0000-0000-000000000001', 'SYSTEM_TREASURY_GOLD',    'SYSTEM', 'Gold Coins Treasury',    'a1000000-0000-0000-0000-000000000001'),
    -- Diamonds Treasury
    ('b1000000-0000-0000-0000-000000000002', 'SYSTEM_TREASURY_DIAMONDS', 'SYSTEM', 'Diamonds Treasury',     'a1000000-0000-0000-0000-000000000002'),
    -- Loyalty Points Treasury
    ('b1000000-0000-0000-0000-000000000003', 'SYSTEM_TREASURY_LOYALTY',  'SYSTEM', 'Loyalty Points Treasury','a1000000-0000-0000-0000-000000000003'),
    -- Revenue Account (receives credits when users spend)
    ('b1000000-0000-0000-0000-000000000004', 'SYSTEM_REVENUE_GOLD',      'SYSTEM', 'Gold Coins Revenue',    'a1000000-0000-0000-0000-000000000001'),
    ('b1000000-0000-0000-0000-000000000005', 'SYSTEM_BONUS_GOLD',        'SYSTEM', 'Gold Coins Bonus Pool', 'a1000000-0000-0000-0000-000000000001')
ON CONFLICT (external_id) DO NOTHING;

-- Initialize system account balances (system accounts can go negative — they represent infinite supply)
INSERT INTO account_balances (account_id, asset_type_id, balance)
VALUES
    ('b1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 0),
    ('b1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000002', 0),
    ('b1000000-0000-0000-0000-000000000003', 'a1000000-0000-0000-0000-000000000003', 0),
    ('b1000000-0000-0000-0000-000000000004', 'a1000000-0000-0000-0000-000000000001', 0),
    ('b1000000-0000-0000-0000-000000000005', 'a1000000-0000-0000-0000-000000000001', 0)
ON CONFLICT (account_id) DO NOTHING;

-- 3. USER ACCOUNTS

INSERT INTO accounts (id, external_id, account_type, name, asset_type_id)
VALUES
    -- User 1: Alice — Gold Coins wallet
    ('c1000000-0000-0000-0000-000000000001', 'user_alice', 'USER', 'Alice', 'a1000000-0000-0000-0000-000000000001'),
    -- User 2: Bob — Gold Coins wallet
    ('c1000000-0000-0000-0000-000000000002', 'user_bob',   'USER', 'Bob',   'a1000000-0000-0000-0000-000000000001'),
    -- User 3: Charlie — Diamonds wallet
    ('c1000000-0000-0000-0000-000000000003', 'user_charlie','USER','Charlie','a1000000-0000-0000-0000-000000000002')
ON CONFLICT (external_id) DO NOTHING;


-- 4. INITIAL BALANCES via Ledger Entries
-- Give Alice 500 Gold Coins and Bob 200 Gold Coins as opening balances.
-- This is recorded as a proper double-entry transaction.


-- Opening balance transaction for Alice (500 Gold Coins)
INSERT INTO transactions (id, type, reference_id, description)
VALUES ('d1000000-0000-0000-0000-000000000001', 'BONUS', 'SEED_OPENING_ALICE_GOLD', 'Opening balance for Alice')
ON CONFLICT (reference_id) DO NOTHING;

INSERT INTO ledger_entries (transaction_id, account_id, asset_type_id, amount, balance_after)
VALUES
    -- Treasury sends 500: DEBIT on treasury (positive = leaving treasury)
    ('d1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',  500, -500),
    -- Alice receives 500: CREDIT on Alice (negative = entering Alice)
    ('d1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', -500,  500)
ON CONFLICT DO NOTHING;

INSERT INTO account_balances (account_id, asset_type_id, balance)
VALUES
    ('c1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 500)
ON CONFLICT (account_id) DO UPDATE SET balance = EXCLUDED.balance;

-- Opening balance transaction for Bob (200 Gold Coins)
INSERT INTO transactions (id, type, reference_id, description)
VALUES ('d1000000-0000-0000-0000-000000000002', 'BONUS', 'SEED_OPENING_BOB_GOLD', 'Opening balance for Bob')
ON CONFLICT (reference_id) DO NOTHING;

INSERT INTO ledger_entries (transaction_id, account_id, asset_type_id, amount, balance_after)
VALUES
    ('d1000000-0000-0000-0000-000000000002', 'b1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',  200, -700),
    ('d1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001', -200,  200)
ON CONFLICT DO NOTHING;

INSERT INTO account_balances (account_id, asset_type_id, balance)
VALUES
    ('c1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000001', 200)
ON CONFLICT (account_id) DO UPDATE SET balance = EXCLUDED.balance;

-- Charlie's opening Diamonds balance (150)
INSERT INTO transactions (id, type, reference_id, description)
VALUES ('d1000000-0000-0000-0000-000000000003', 'BONUS', 'SEED_OPENING_CHARLIE_DIAMONDS', 'Opening balance for Charlie')
ON CONFLICT (reference_id) DO NOTHING;

INSERT INTO ledger_entries (transaction_id, account_id, asset_type_id, amount, balance_after)
VALUES
    ('d1000000-0000-0000-0000-000000000003', 'b1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000002',  150, -150),
    ('d1000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000003', 'a1000000-0000-0000-0000-000000000002', -150,  150)
ON CONFLICT DO NOTHING;

INSERT INTO account_balances (account_id, asset_type_id, balance)
VALUES
    ('c1000000-0000-0000-0000-000000000003', 'a1000000-0000-0000-0000-000000000002', 150)
ON CONFLICT (account_id) DO UPDATE SET balance = EXCLUDED.balance;

-- VERIFY SEED DATA

DO $$
DECLARE
    alice_balance NUMERIC;
    bob_balance   NUMERIC;
BEGIN
    SELECT balance INTO alice_balance FROM account_balances WHERE account_id = 'c1000000-0000-0000-0000-000000000001';
    SELECT balance INTO bob_balance   FROM account_balances WHERE account_id = 'c1000000-0000-0000-0000-000000000002';

    RAISE NOTICE '✅ Seed complete. Alice balance: %, Bob balance: %', alice_balance, bob_balance;
END $$;
