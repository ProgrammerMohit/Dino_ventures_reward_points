const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'wallet_service',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',

  // Connection pool settings for high-traffic
  min:                  2,
  max:                  20,
  idleTimeoutMillis:    30000,
  connectionTimeoutMillis: 5000,
  acquireTimeoutMillis: 15000,
});

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
});

/**
 * Execute a function within a serializable transaction.
 * Automatically retries on deadlock (PostgreSQL error 40P01)
 * or serialization failure (40001).
 *
 * @param {Function} fn - async (client) => result
 * @param {number}   maxRetries
 */
async function withTransaction(fn, maxRetries = 3) {
  let attempt = 0;

  while (attempt < maxRetries) {
    const client = await pool.connect();
    try {
      // SERIALIZABLE provides the strongest isolation and prevents
      // phantom reads and write skew, crucial for financial data.
      // PostgreSQL implements this via SSI (Serializable Snapshot Isolation)
      // which is deadlock-safe unlike traditional locking approaches.
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

      const result = await fn(client);

      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');

      const isRetryable =
        err.code === '40001' || // serialization_failure
        err.code === '40P01';   // deadlock_detected

      if (isRetryable && attempt < maxRetries - 1) {
        attempt++;
        // Exponential backoff with jitter
        const delay = Math.min(50 * Math.pow(2, attempt) + Math.random() * 50, 2000);
        console.warn(`Retryable DB error (${err.code}), attempt ${attempt}/${maxRetries}. Retrying in ${delay.toFixed(0)}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = { pool, withTransaction };
