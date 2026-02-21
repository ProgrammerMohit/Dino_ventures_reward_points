const { Pool } = require('pg');

let pool;

if (process.env.DATABASE_URL) {
  // Render / production
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    },
    min: 2,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
} else {
  // Local development
  pool = new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME     || 'wallet_service',
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    min: 2,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
}

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
});

/**
 * Transaction helper
 */
async function withTransaction(fn, maxRetries = 3) {
  let attempt = 0;

  while (attempt < maxRetries) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');

      const retryable =
        err.code === '40001' ||
        err.code === '40P01';

      if (retryable && attempt < maxRetries - 1) {
        attempt++;
        await new Promise(r =>
          setTimeout(r, Math.min(50 * 2 ** attempt, 2000))
        );
        continue;
      }

      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = {
  pool,
  withTransaction
};