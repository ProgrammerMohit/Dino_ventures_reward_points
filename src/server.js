'use strict';

require('dotenv').config();

const express     = require('express');
const helmet      = require('helmet');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');

const walletRoutes              = require('./routes/walletRoutes');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { pool }                  = require('./config/database');

const app  = express();
const PORT = process.env.PORT || 3000;

// Security middleware 
app.use(helmet());
app.disable('x-powered-by');

// Request logging 
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Body parsing 
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

//Rate limiting 
// General limiter: 300 requests per minute per IP
const generalLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             300,
  standardHeaders: true,
  legacyHeaders:   false,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' },
  },
});

// Stricter limiter for write endpoints
const writeLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             60,
  standardHeaders: true,
  legacyHeaders:   false,
  message: {
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many transaction requests. Please slow down.' },
  },
});

app.use('/api/', generalLimiter);
app.use('/api/v1/wallet/topup', writeLimiter);
app.use('/api/v1/wallet/bonus', writeLimiter);
app.use('/api/v1/wallet/spend', writeLimiter);

// Health check 
app.get('/health', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT NOW() AS time, version() AS pg_version');
    return res.status(200).json({
      status:   'healthy',
      service:  'wallet-service',
      version:  '1.0.0',
      database: {
        connected: true,
        time:      rows[0].time,
        version:   rows[0].pg_version.split(' ')[0] + ' ' + rows[0].pg_version.split(' ')[1],
      },
    });
  } catch (err) {
    return res.status(503).json({
      status:   'unhealthy',
      database: { connected: false, error: err.message },
    });
  }
});

// API routes 
app.use('/api/v1/wallet', walletRoutes);

//404 & error handlers 
app.use(notFoundHandler);
app.use(errorHandler);

//Start server
let server;
if (process.env.NODE_ENV !== 'test') {
  server = app.listen(PORT, () => {
    console.log(`\n🚀 Wallet Service running on port ${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`   Health: http://localhost:${PORT}/health\n`);
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  if (server) server.close();
  await pool.end();
  process.exit(0);
});

module.exports = app; // export for testing
