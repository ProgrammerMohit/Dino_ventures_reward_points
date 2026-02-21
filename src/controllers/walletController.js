'use strict';

const walletService = require('../services/walletService');

// POST /api/v1/wallet/topup

async function topUp(req, res, next) {
  try {
    const result = await walletService.topUpWallet(req.body);
    const statusCode = result.idempotent ? 200 : 201;
    return res.status(statusCode).json({
      success: true,
      data:    result,
    });
  } catch (err) {
    return next(err);
  }
}


// POST /api/v1/wallet/bonus

async function issueBonus(req, res, next) {
  try {
    const result = await walletService.issueBonus(req.body);
    const statusCode = result.idempotent ? 200 : 201;
    return res.status(statusCode).json({
      success: true,
      data:    result,
    });
  } catch (err) {
    return next(err);
  }
}

// POST /api/v1/wallet/spend

async function spend(req, res, next) {
  try {
    const result = await walletService.spendCredits(req.body);
    const statusCode = result.idempotent ? 200 : 201;
    return res.status(statusCode).json({
      success: true,
      data:    result,
    });
  } catch (err) {
    return next(err);
  }
}


// GET /api/v1/wallet/balance/:accountId

async function getBalance(req, res, next) {
  try {
    const { accountId } = req.validated;
    const result = await walletService.getBalance(accountId);
    return res.status(200).json({
      success: true,
      data:    result,
    });
  } catch (err) {
    return next(err);
  }
}


// GET /api/v1/wallet/history/:accountId

async function getHistory(req, res, next) {
  try {
    const { accountId, limit, offset, type } = req.validated;
    const result = await walletService.getTransactionHistory(accountId, { limit, offset, type });
    return res.status(200).json({
      success: true,
      data:    result,
    });
  } catch (err) {
    return next(err);
  }
}


// GET /api/v1/wallet/accounts

async function listAccounts(req, res, next) {
  try {
    const { accountType, assetCode, limit = 50, offset = 0 } = req.query;
    const result = await walletService.listAccounts({ accountType, assetCode, limit: parseInt(limit), offset: parseInt(offset) });
    return res.status(200).json({
      success: true,
      data:    result,
    });
  } catch (err) {
    return next(err);
  }
}

// GET /api/v1/wallet/audit/:accountId

async function auditBalance(req, res, next) {
  try {
    const { accountId } = req.params;
    const result = await walletService.verifyLedgerIntegrity(accountId);
    return res.status(200).json({
      success: true,
      data:    result,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { topUp, issueBonus, spend, getBalance, getHistory, listAccounts, auditBalance };
