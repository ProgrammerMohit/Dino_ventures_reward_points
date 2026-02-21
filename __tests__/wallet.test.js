'use strict';

const request = require('supertest');
const { Pool } = require('pg');
const app      = require('../src/server');

// Test Database Configuration

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'wallet_service_test',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
});

// Seed test accounts for use in tests
const TEST_ACCOUNTS = {
  alice:   'c1000000-0000-0000-0000-000000000001',
  bob:     'c1000000-0000-0000-0000-000000000002',
  charlie: 'c1000000-0000-0000-0000-000000000003',
};


// HEALTH CHECK
describe('GET /health', () => {
  it('returns 200 and healthy status', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.database.connected).toBe(true);
  });
});


// BALANCE
describe('GET /api/v1/wallet/balance/:accountId', () => {
  it('returns balance for a seeded user', async () => {
    const res = await request(app).get(`/api/v1/wallet/balance/${TEST_ACCOUNTS.alice}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      accountId: TEST_ACCOUNTS.alice,
      balance:   expect.any(Number),
    });
    expect(res.body.data.balance).toBeGreaterThanOrEqual(0);
  });

  it('returns 404 for unknown account', async () => {
    const res = await request(app).get('/api/v1/wallet/balance/00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('returns 400 for invalid UUID', async () => {
    const res = await request(app).get('/api/v1/wallet/balance/not-a-uuid');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});


// TOP-UP
describe('POST /api/v1/wallet/topup', () => {
  const uniqueRef = () => `test-topup-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  it('credits a user wallet and returns correct data', async () => {
    const refId = uniqueRef();
    const res = await request(app)
      .post('/api/v1/wallet/topup')
      .send({ accountId: TEST_ACCOUNTS.alice, amount: 100, referenceId: refId, description: 'Test top-up' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      type:       'TOP_UP',
      accountId:  TEST_ACCOUNTS.alice,
      amount:     100,
      referenceId: refId,
    });
    expect(res.body.data.balanceAfter).toBeGreaterThan(0);
    expect(res.body.data.transactionId).toBeDefined();
  });

  it('is idempotent — second request returns 200 and same result', async () => {
    const refId = uniqueRef();
    const body  = { accountId: TEST_ACCOUNTS.alice, amount: 50, referenceId: refId };

    const res1 = await request(app).post('/api/v1/wallet/topup').send(body);
    const res2 = await request(app).post('/api/v1/wallet/topup').send(body);

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(200);
    expect(res2.body.data.idempotent).toBe(true);
    // Balance should only have been credited ONCE
    expect(res2.body.data.balanceAfter).toBe(res1.body.data.balanceAfter);
  });

  it('returns 400 for missing referenceId', async () => {
    const res = await request(app)
      .post('/api/v1/wallet/topup')
      .send({ accountId: TEST_ACCOUNTS.alice, amount: 10 });
    expect(res.status).toBe(400);
  });

  it('returns 400 for negative amount', async () => {
    const res = await request(app)
      .post('/api/v1/wallet/topup')
      .send({ accountId: TEST_ACCOUNTS.alice, amount: -50, referenceId: uniqueRef() });
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-existent account', async () => {
    const res = await request(app)
      .post('/api/v1/wallet/topup')
      .send({ accountId: '00000000-0000-4000-8000-000000000001', amount: 100, referenceId: uniqueRef() });
    expect(res.status).toBe(404);
  });
});


// BONUS

describe('POST /api/v1/wallet/bonus', () => {
  const uniqueRef = () => `test-bonus-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  it('issues a bonus and increases balance', async () => {
    // Get balance before
    const before = await request(app).get(`/api/v1/wallet/balance/${TEST_ACCOUNTS.bob}`);
    const balanceBefore = before.body.data.balance;

    const res = await request(app)
      .post('/api/v1/wallet/bonus')
      .send({ accountId: TEST_ACCOUNTS.bob, amount: 25, referenceId: uniqueRef(), description: 'Referral bonus' });

    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe('BONUS');
    expect(res.body.data.balanceAfter).toBe(balanceBefore + 25);
  });

  it('is idempotent', async () => {
    const refId = uniqueRef();
    const body  = { accountId: TEST_ACCOUNTS.bob, amount: 10, referenceId: refId };
    const r1    = await request(app).post('/api/v1/wallet/bonus').send(body);
    const r2    = await request(app).post('/api/v1/wallet/bonus').send(body);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect(r2.body.data.idempotent).toBe(true);
  });
});


// SPEND
describe('POST /api/v1/wallet/spend', () => {
  const uniqueRef = () => `test-spend-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  it('deducts credits and returns correct balance', async () => {
    // First, top up to ensure sufficient balance
    await request(app).post('/api/v1/wallet/topup').send({
      accountId: TEST_ACCOUNTS.alice, amount: 200, referenceId: uniqueRef(),
    });

    const before = await request(app).get(`/api/v1/wallet/balance/${TEST_ACCOUNTS.alice}`);
    const balanceBefore = before.body.data.balance;

    const refId = uniqueRef();
    const res   = await request(app)
      .post('/api/v1/wallet/spend')
      .send({ accountId: TEST_ACCOUNTS.alice, amount: 30, referenceId: refId, description: 'Buy item' });

    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe('SPEND');
    expect(res.body.data.balanceAfter).toBe(balanceBefore - 30);
  });

  it('returns 422 when balance is insufficient', async () => {
    const res = await request(app)
      .post('/api/v1/wallet/spend')
      .send({ accountId: TEST_ACCOUNTS.bob, amount: 999_999, referenceId: uniqueRef() });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INSUFFICIENT_BALANCE');
  });

  it('is idempotent — balance not double-debited', async () => {
    // Ensure enough balance
    await request(app).post('/api/v1/wallet/topup').send({
      accountId: TEST_ACCOUNTS.alice, amount: 500, referenceId: uniqueRef(),
    });

    const refId = uniqueRef();
    const body  = { accountId: TEST_ACCOUNTS.alice, amount: 10, referenceId: refId };

    const r1 = await request(app).post('/api/v1/wallet/spend').send(body);
    const r2 = await request(app).post('/api/v1/wallet/spend').send(body);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect(r2.body.data.idempotent).toBe(true);
    expect(r2.body.data.balanceAfter).toBe(r1.body.data.balanceAfter); // Not double-spent
  });
});

// TRANSACTION HISTORY

describe('GET /api/v1/wallet/history/:accountId', () => {
  it('returns paginated history', async () => {
    const res = await request(app)
      .get(`/api/v1/wallet/history/${TEST_ACCOUNTS.alice}`)
      .query({ limit: 5, offset: 0 });

    expect(res.status).toBe(200);
    expect(res.body.data.entries).toBeInstanceOf(Array);
    expect(res.body.data.total).toBeGreaterThanOrEqual(0);
    expect(res.body.data.limit).toBe(5);
  });

  it('filters by transaction type', async () => {
    const res = await request(app)
      .get(`/api/v1/wallet/history/${TEST_ACCOUNTS.alice}`)
      .query({ type: 'TOP_UP' });

    expect(res.status).toBe(200);
    res.body.data.entries.forEach((e) => {
      expect(e.type).toBe('TOP_UP');
    });
  });
});


// AUDIT

describe('GET /api/v1/wallet/audit/:accountId', () => {
  it('reports consistent ledger for seeded account', async () => {
    const res = await request(app).get(`/api/v1/wallet/audit/${TEST_ACCOUNTS.alice}`);
    expect(res.status).toBe(200);
    expect(res.body.data.isConsistent).toBe(true);
    expect(res.body.data.discrepancy).toBe(0);
  });
});


// 404 & UNKNOWN ROUTES

describe('Unknown routes', () => {
  it('returns 404 for unknown path', async () => {
    const res = await request(app).get('/api/v1/nonexistent');
    expect(res.status).toBe(404);
  });
});
