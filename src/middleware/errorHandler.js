'use strict';

/**
 * Central error handler.
 * Maps known error codes to appropriate HTTP status codes.
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  // Log the error internally (in production, send to observability platform)
  const isClientError = err.statusCode && err.statusCode < 500;
  if (!isClientError) {
    console.error(`[ERROR] ${req.method} ${req.path} -`, err.message, err.stack);
  }

  // Map known application error codes
  const errorMap = {
    ACCOUNT_NOT_FOUND:    { status: 404, code: 'ACCOUNT_NOT_FOUND' },
    INSUFFICIENT_BALANCE: { status: 422, code: 'INSUFFICIENT_BALANCE' },
    DUPLICATE_REFERENCE:  { status: 409, code: 'DUPLICATE_REFERENCE' },
    VALIDATION_ERROR:     { status: 400, code: 'VALIDATION_ERROR' },
    ASSET_MISMATCH:       { status: 400, code: 'ASSET_MISMATCH' },
  };

  const mapped = err.code ? errorMap[err.code] : null;
  const status = mapped?.status || err.statusCode || 500;

  // PostgreSQL-specific errors
  let pgError = null;
  if (err.code === '23505') {
    // Unique violation — typically a duplicate reference_id
    pgError = { status: 409, code: 'DUPLICATE_REFERENCE', message: 'A transaction with this referenceId already exists' };
  }

  const response = pgError || {
    code:    mapped?.code || 'INTERNAL_ERROR',
    message: isClientError ? err.message : 'An internal error occurred. Please try again.',
  };

  return res.status(pgError?.status || status).json({
    success: false,
    error:   response,
    ...(process.env.NODE_ENV === 'development' && !isClientError && {
      debug: { stack: err.stack }
    }),
  });
}

/**
 * 404 handler for unknown routes.
 */
function notFoundHandler(req, res) {
  return res.status(404).json({
    success: false,
    error: {
      code:    'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`,
    },
  });
}

module.exports = { errorHandler, notFoundHandler };
