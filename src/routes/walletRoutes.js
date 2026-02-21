'use strict';

const express = require('express');
const router  = express.Router();

const controller = require('../controllers/walletController');
const { validateBody, validateQuery } = require('../middleware/validation');

// ── Transactions ─────────────────────────────────────────────
/**
 * @route   POST /api/v1/wallet/topup
 * @desc    Top up a user's wallet with purchased credits
 * @body    { accountId, amount, referenceId, description?, metadata? }
 * @returns 201 on success, 200 if idempotent replay
 */
router.post('/topup', validateBody('topUp'), controller.topUp);

/**
 * @route   POST /api/v1/wallet/bonus
 * @desc    Issue a free-credit bonus to a user (referral, promo, etc.)
 * @body    { accountId, amount, referenceId, description?, metadata? }
 */
router.post('/bonus', validateBody('bonus'), controller.issueBonus);

/**
 * @route   POST /api/v1/wallet/spend
 * @desc    Deduct credits from a user's wallet for an in-app purchase
 * @body    { accountId, amount, referenceId, description?, metadata? }
 */
router.post('/spend', validateBody('spend'), controller.spend);

// ── Queries ───────────────────────────────────────────────────
/**
 * @route   GET /api/v1/wallet/balance/:accountId
 * @desc    Get the current balance of an account
 */
router.get('/balance/:accountId', validateQuery('getBalance'), controller.getBalance);

/**
 * @route   GET /api/v1/wallet/history/:accountId
 * @desc    Get paginated transaction history for an account
 * @query   limit, offset, type (TOP_UP | BONUS | SPEND)
 */
router.get('/history/:accountId', validateQuery('getHistory'), controller.getHistory);

// ── Admin ─────────────────────────────────────────────────────
/**
 * @route   GET /api/v1/wallet/accounts
 * @desc    List all accounts (admin view)
 * @query   accountType, assetCode, limit, offset
 */
router.get('/accounts', controller.listAccounts);

/**
 * @route   GET /api/v1/wallet/audit/:accountId
 * @desc    Verify ledger integrity — compare cached balance vs ledger sum
 *          Used for auditing and data consistency checks
 */
router.get('/audit/:accountId', controller.auditBalance);

module.exports = router;
