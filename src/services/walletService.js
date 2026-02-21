'use strict';

const { withTransaction, pool } = require('../config/database');
const { v4: uuidv4 } = require('uuid');


// SYSTEM ACCOUNT LOOKUPS

const SYSTEM_ACCOUNTS = {
  TREASURY:    { externalId: 'SYSTEM_TREASURY_GOLD' },
  DIAMONDS:    { externalId: 'SYSTEM_TREASURY_DIAMONDS' },
  LOYALTY:     { externalId: 'SYSTEM_TREASURY_LOYALTY' },
  REVENUE:     { externalId: 'SYSTEM_REVENUE_GOLD' },
  BONUS_POOL:  { externalId: 'SYSTEM_BONUS_GOLD' },
};

/**
 * Resolve an account by its external ID.
 * Used to look up system accounts by their well-known IDs.
 */
async function getAccountByExternalId(client, externalId) {
  const { rows } = await client.query(
    `SELECT a.*, ab.balance
     FROM accounts a
     JOIN account_balances ab ON ab.account_id = a.id
     WHERE a.external_id = $1 AND a.is_active = TRUE`,
    [externalId]
  );
  return rows[0] || null;
}

/**
 * Resolve an account by its UUID.
 * Locks the account_balances row FOR UPDATE to prevent race conditions.
 *
 * The SELECT FOR UPDATE on account_balances ensures that concurrent
 * transactions modifying the same account are serialized at the database
 * level. Combined with SERIALIZABLE isolation, this is our primary
 * concurrency control mechanism.
 */
async function getAccountWithLock(client, accountId) {
  const { rows } = await client.query(
    `SELECT a.*, ab.balance, ab.version
     FROM accounts a
     JOIN account_balances ab ON ab.account_id = a.id
     WHERE a.id = $1 AND a.is_active = TRUE
     FOR UPDATE OF ab`,  // Lock only the balance row, not the account definition
    [accountId]
  );
  return rows[0] || null;
}

/**
 * Acquire locks on multiple accounts in a CONSISTENT ORDER to prevent
 * deadlocks. Always lock accounts by ascending UUID to ensure two
 * concurrent transactions touching the same two accounts always acquire
 * locks in the same order.
 *
 * Without this: Tx1 locks Alice then Bob; Tx2 locks Bob then Alice → deadlock.
 * With this:    Both Tx1 and Tx2 lock accounts in UUID order → no deadlock.
 */
async function getAccountsWithLock(client, accountIds) {
  // Deduplicate and sort for consistent lock ordering
  const sortedIds = [...new Set(accountIds)].sort();

  const { rows } = await client.query(
    `SELECT a.*, ab.balance, ab.version
     FROM accounts a
     JOIN account_balances ab ON ab.account_id = a.id
     WHERE a.id = ANY($1::uuid[]) AND a.is_active = TRUE
     ORDER BY a.id ASC
     FOR UPDATE OF ab`,
    [sortedIds]
  );
  return rows;
}

/**
 * Post a double-entry ledger entry pair.
 *
 * Every money movement involves exactly TWO entries:
 *   1. DEBIT on the source account  (positive amount  = funds leaving)
 *   2. CREDIT on the dest account   (negative amount  = funds arriving)
 *
 * Invariant: debitAmount + creditAmount === 0 (they cancel out)
 *
 * @param {object} client         - DB client (within a transaction)
 * @param {string} transactionId  - Parent transaction ID
 * @param {object} debitAccount   - Account being debited (funds leave here)
 * @param {object} creditAccount  - Account being credited (funds arrive here)
 * @param {number} amount         - Positive amount to move
 * @param {string} assetTypeId    - Which asset is moving
 */
async function postDoubleEntry(client, transactionId, debitAccount, creditAccount, amount, assetTypeId) {
  const debitNewBalance  = parseFloat(debitAccount.balance)  - amount;
  const creditNewBalance = parseFloat(creditAccount.balance) + amount;

  // For user accounts only: ensure balance cannot go negative
  if (creditAccount.account_type === 'USER' && creditAccount.balance !== undefined) {
    // This branch is about the debit side going negative (spending more than available)
  }
  if (debitAccount.account_type === 'USER' && debitNewBalance < 0) {
    const err = new Error(`Insufficient balance. Available: ${debitAccount.balance}, Required: ${amount}`);
    err.code = 'INSUFFICIENT_BALANCE';
    err.statusCode = 422;
    throw err;
  }

  // Insert DEBIT entry (amount is positive = funds leaving debitAccount)
  await client.query(
    `INSERT INTO ledger_entries (transaction_id, account_id, asset_type_id, amount, balance_after)
     VALUES ($1, $2, $3, $4, $5)`,
    [transactionId, debitAccount.id, assetTypeId, amount, debitNewBalance]
  );

  // Insert CREDIT entry (amount is negative = funds entering creditAccount)
  await client.query(
    `INSERT INTO ledger_entries (transaction_id, account_id, asset_type_id, amount, balance_after)
     VALUES ($1, $2, $3, $4, $5)`,
    [transactionId, creditAccount.id, assetTypeId, -amount, creditNewBalance]
  );

  // Update materialized balance cache for both accounts
  await client.query(
    `UPDATE account_balances
     SET balance = $2, version = version + 1, updated_at = NOW()
     WHERE account_id = $1`,
    [debitAccount.id, debitNewBalance]
  );

  await client.query(
    `UPDATE account_balances
     SET balance = $2, version = version + 1, updated_at = NOW()
     WHERE account_id = $1`,
    [creditAccount.id, creditNewBalance]
  );

  return { debitNewBalance, creditNewBalance };
}

/**
 * Check and return a cached idempotency response.
 * Returns the cached response if found, null otherwise.
 */
async function checkIdempotency(client, referenceId) {
  const { rows } = await client.query(
    `SELECT response_status, response_body
     FROM idempotency_keys
     WHERE key = $1 AND expires_at > NOW()`,
    [referenceId]
  );
  return rows[0] || null;
}

/**
 * Store the result of a transaction for idempotency.
 */
async function storeIdempotencyResult(client, referenceId, statusCode, body) {
  await client.query(
    `INSERT INTO idempotency_keys (key, response_status, response_body)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO NOTHING`,
    [referenceId, statusCode, JSON.stringify(body)]
  );
}


// FLOW 1: WALLET TOP-UP
// User purchases credits via a payment gateway.
// Money flow: Treasury → User Wallet

async function topUpWallet({ accountId, amount, referenceId, description, metadata }) {
  return withTransaction(async (client) => {
    // 1. Idempotency check — if this referenceId was already processed,
    //    return the exact same response without any side effects.
    const cached = await checkIdempotency(client, referenceId);
    if (cached) {
      return { ...cached.response_body, idempotent: true };
    }

    // 2. Look up the user account + treasury, acquiring locks in sorted order
    //    to prevent deadlocks between concurrent top-up requests.
    const treasury = await getAccountByExternalId(client, SYSTEM_ACCOUNTS.TREASURY.externalId);
    if (!treasury) throw Object.assign(new Error('Treasury account not configured'), { statusCode: 500 });

    const accounts = await getAccountsWithLock(client, [accountId, treasury.id]);
    const userAccount = accounts.find((a) => a.id === accountId);

    if (!userAccount) {
      const err = new Error(`Account ${accountId} not found or inactive`);
      err.code = 'ACCOUNT_NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }

    // Ensure asset types match
    if (userAccount.asset_type_id !== treasury.asset_type_id) {
      throw Object.assign(new Error('Asset type mismatch between account and treasury'), { statusCode: 400 });
    }

    const treasuryLocked = accounts.find((a) => a.id === treasury.id);

    // 3. Create the parent transaction record
    const txId = uuidv4();
    await client.query(
      `INSERT INTO transactions (id, type, reference_id, description, metadata)
       VALUES ($1, 'TOP_UP', $2, $3, $4)`,
      [txId, referenceId, description || 'Wallet top-up', JSON.stringify(metadata || {})]
    );

    // 4. Post double-entry: Treasury debited, User credited
    const { creditNewBalance } = await postDoubleEntry(
      client,
      txId,
      treasuryLocked || treasury,  // debit: treasury (funds leave treasury)
      userAccount,                  // credit: user (funds arrive at user)
      amount,
      userAccount.asset_type_id
    );

    const result = {
      transactionId:  txId,
      referenceId,
      type:           'TOP_UP',
      accountId,
      amount,
      balanceAfter:   creditNewBalance,
      description:    description || 'Wallet top-up',
      createdAt:      new Date().toISOString(),
    };

    // 5. Store idempotency result so duplicate requests are handled safely
    await storeIdempotencyResult(client, referenceId, 201, result);

    return result;
  });
}


// FLOW 2: BONUS / INCENTIVE
// System issues free credits to a user (referral bonus, promo).
// Money flow: Bonus Pool → User Wallet
async function issueBonus({ accountId, amount, referenceId, description, metadata }) {
  return withTransaction(async (client) => {
    const cached = await checkIdempotency(client, referenceId);
    if (cached) return { ...cached.response_body, idempotent: true };

    const bonusPool = await getAccountByExternalId(client, SYSTEM_ACCOUNTS.BONUS_POOL.externalId);
    if (!bonusPool) throw Object.assign(new Error('Bonus pool not configured'), { statusCode: 500 });

    const accounts = await getAccountsWithLock(client, [accountId, bonusPool.id]);
    const userAccount = accounts.find((a) => a.id === accountId);

    if (!userAccount) {
      const err = new Error(`Account ${accountId} not found or inactive`);
      err.code = 'ACCOUNT_NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }

    const bonusPoolLocked = accounts.find((a) => a.id === bonusPool.id);

    const txId = uuidv4();
    await client.query(
      `INSERT INTO transactions (id, type, reference_id, description, metadata)
       VALUES ($1, 'BONUS', $2, $3, $4)`,
      [txId, referenceId, description || 'Bonus issued', JSON.stringify(metadata || {})]
    );

    // Bonus Pool → User
    const { creditNewBalance } = await postDoubleEntry(
      client,
      txId,
      bonusPoolLocked || bonusPool,
      userAccount,
      amount,
      userAccount.asset_type_id
    );

    const result = {
      transactionId: txId,
      referenceId,
      type:          'BONUS',
      accountId,
      amount,
      balanceAfter:  creditNewBalance,
      description:   description || 'Bonus issued',
      createdAt:     new Date().toISOString(),
    };

    await storeIdempotencyResult(client, referenceId, 201, result);
    return result;
  });
}


// FLOW 3: SPEND / PURCHASE
// User spends credits to buy something in the app.
// Money flow: User Wallet → Revenue Account

async function spendCredits({ accountId, amount, referenceId, description, metadata }) {
  return withTransaction(async (client) => {
    const cached = await checkIdempotency(client, referenceId);
    if (cached) return { ...cached.response_body, idempotent: true };

    const revenue = await getAccountByExternalId(client, SYSTEM_ACCOUNTS.REVENUE.externalId);
    if (!revenue) throw Object.assign(new Error('Revenue account not configured'), { statusCode: 500 });

    // Lock in sorted UUID order to prevent deadlocks
    const accounts = await getAccountsWithLock(client, [accountId, revenue.id]);
    const userAccount = accounts.find((a) => a.id === accountId);

    if (!userAccount) {
      const err = new Error(`Account ${accountId} not found or inactive`);
      err.code = 'ACCOUNT_NOT_FOUND';
      err.statusCode = 404;
      throw err;
    }

    // Validate sufficient balance BEFORE creating any records
    if (parseFloat(userAccount.balance) < amount) {
      const err = new Error(
        `Insufficient balance. Available: ${userAccount.balance}, Required: ${amount}`
      );
      err.code  = 'INSUFFICIENT_BALANCE';
      err.statusCode = 422;
      throw err;
    }

    const revenueLocked = accounts.find((a) => a.id === revenue.id);

    const txId = uuidv4();
    await client.query(
      `INSERT INTO transactions (id, type, reference_id, description, metadata)
       VALUES ($1, 'SPEND', $2, $3, $4)`,
      [txId, referenceId, description || 'Credit spend', JSON.stringify(metadata || {})]
    );

    // User → Revenue (user is debited, revenue is credited)
    const { debitNewBalance } = await postDoubleEntry(
      client,
      txId,
      userAccount,                  // debit: user (funds leave user)
      revenueLocked || revenue,     // credit: revenue (funds arrive at revenue)
      amount,
      userAccount.asset_type_id
    );

    const result = {
      transactionId: txId,
      referenceId,
      type:          'SPEND',
      accountId,
      amount,
      balanceAfter:  debitNewBalance,
      description:   description || 'Credit spend',
      createdAt:     new Date().toISOString(),
    };

    await storeIdempotencyResult(client, referenceId, 201, result);
    return result;
  });
}


// QUERY: GET BALANCE
// Returns the cached balance (fast path) and the ledger-derived
// balance (audit path) for a given account.

async function getBalance(accountId) {
  const { rows } = await pool.query(
    `SELECT
       a.id,
       a.external_id,
       a.name,
       a.account_type,
       at.code         AS asset_code,
       at.name         AS asset_name,
       ab.balance      AS cached_balance,
       ab.version,
       ab.updated_at
     FROM accounts a
     JOIN asset_types at ON at.id = a.asset_type_id
     JOIN account_balances ab ON ab.account_id = a.id
     WHERE a.id = $1 AND a.is_active = TRUE`,
    [accountId]
  );

  if (!rows.length) {
    const err = new Error(`Account ${accountId} not found`);
    err.code = 'ACCOUNT_NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }

  const account = rows[0];

  return {
    accountId:    account.id,
    externalId:   account.external_id,
    name:         account.name,
    accountType:  account.account_type,
    asset: {
      code: account.asset_code,
      name: account.asset_name,
    },
    balance:      parseFloat(account.cached_balance),
    version:      account.version,
    updatedAt:    account.updated_at,
  };
}


// QUERY: GET TRANSACTION HISTORY
// Paginated ledger history for an account.

async function getTransactionHistory(accountId, { limit = 20, offset = 0, type } = {}) {
  // Verify account exists
  const accountCheck = await pool.query(
    'SELECT id FROM accounts WHERE id = $1 AND is_active = TRUE',
    [accountId]
  );
  if (!accountCheck.rows.length) {
    const err = new Error(`Account ${accountId} not found`);
    err.code = 'ACCOUNT_NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }

  const params = [accountId, limit, offset];
  let typeFilter = '';
  if (type) {
    params.push(type.toUpperCase());
    typeFilter = `AND t.type = $${params.length}`;
  }

  const { rows } = await pool.query(
    `SELECT
       t.id            AS transaction_id,
       t.type,
       t.reference_id,
       t.description,
       t.metadata,
       le.amount,
       le.balance_after,
       t.created_at
     FROM ledger_entries le
     JOIN transactions t ON t.id = le.transaction_id
     WHERE le.account_id = $1
     ${typeFilter}
     ORDER BY t.created_at DESC
     LIMIT $2 OFFSET $3`,
    params
  );

  const countParams = [accountId];
  let countTypeFilter = '';
  if (type) {
    countParams.push(type.toUpperCase());
    countTypeFilter = `AND t.type = $${countParams.length}`;
  }

  const { rows: countRows } = await pool.query(
    `SELECT COUNT(*)::int AS total
     FROM ledger_entries le
     JOIN transactions t ON t.id = le.transaction_id
     WHERE le.account_id = $1 ${countTypeFilter}`,
    countParams
  );

  return {
    accountId,
    total:       countRows[0].total,
    limit,
    offset,
    entries:     rows.map((r) => ({
      transactionId: r.transaction_id,
      type:          r.type,
      referenceId:   r.reference_id,
      description:   r.description,
      metadata:      r.metadata,
      // Positive amount = funds left this account (debit)
      // Negative amount = funds arrived at this account (credit)
      // We invert for user-facing display: positive = received, negative = spent
      amount:        -parseFloat(r.amount),
      balanceAfter:  parseFloat(r.balance_after),
      createdAt:     r.created_at,
    })),
  };
}


// QUERY: GET ALL ACCOUNTS (admin view)
async function listAccounts({ accountType, assetCode, limit = 50, offset = 0 } = {}) {
  const params = [limit, offset];
  const filters = [];

  if (accountType) {
    params.push(accountType.toUpperCase());
    filters.push(`a.account_type = $${params.length}`);
  }
  if (assetCode) {
    params.push(assetCode.toUpperCase());
    filters.push(`at.code = $${params.length}`);
  }

  const whereClause = filters.length ? `WHERE ${filters.join(' AND ')} AND a.is_active = TRUE` : 'WHERE a.is_active = TRUE';

  const { rows } = await pool.query(
    `SELECT
       a.id,
       a.external_id,
       a.name,
       a.account_type,
       at.code  AS asset_code,
       at.name  AS asset_name,
       ab.balance,
       a.created_at
     FROM accounts a
     JOIN asset_types at ON at.id = a.asset_type_id
     JOIN account_balances ab ON ab.account_id = a.id
     ${whereClause}
     ORDER BY a.created_at DESC
     LIMIT $1 OFFSET $2`,
    params
  );

  return rows.map((r) => ({
    accountId:   r.id,
    externalId:  r.external_id,
    name:        r.name,
    accountType: r.account_type,
    asset: {
      code: r.asset_code,
      name: r.asset_name,
    },
    balance:    parseFloat(r.balance),
    createdAt:  r.created_at,
  }));
}


// AUDIT: VERIFY LEDGER INTEGRITY
// Compares materialized balance cache with ledger-derived sum.
// Used for auditing and detecting any data inconsistencies.

async function verifyLedgerIntegrity(accountId) {
  const { rows } = await pool.query(
    `SELECT * FROM verify_balance_integrity($1::uuid)`,
    [accountId]
  );

  if (!rows.length) {
    const err = new Error(`Account ${accountId} not found`);
    err.statusCode = 404;
    throw err;
  }

  return {
    accountId,
    cachedBalance:  parseFloat(rows[0].cached_balance),
    ledgerBalance:  parseFloat(rows[0].ledger_balance),
    isConsistent:   rows[0].is_consistent,
    discrepancy:    Math.abs(parseFloat(rows[0].cached_balance) - parseFloat(rows[0].ledger_balance)),
  };
}

module.exports = {
  topUpWallet,
  issueBonus,
  spendCredits,
  getBalance,
  getTransactionHistory,
  listAccounts,
  verifyLedgerIntegrity,
};
