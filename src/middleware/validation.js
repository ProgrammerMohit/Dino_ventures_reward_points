'use strict';

const Joi = require('joi');
// VALIDATION SCHEMAS


const amountSchema = Joi.number()
  .positive()
  .precision(8)
  .max(10_000_000)
  .required()
  .messages({
    'number.positive': 'amount must be a positive number',
    'number.max':      'amount cannot exceed 10,000,000 per transaction',
  });

const referenceIdSchema = Joi.string()
  .max(255)
  .required()
  .messages({
    'string.max': 'referenceId cannot exceed 255 characters',
  });

const schemas = {
  topUp: Joi.object({
    accountId:   Joi.string().uuid().required(),
    amount:      amountSchema,
    referenceId: referenceIdSchema,
    description: Joi.string().max(500).optional(),
    metadata:    Joi.object().optional(),
  }),

  bonus: Joi.object({
    accountId:   Joi.string().uuid().required(),
    amount:      amountSchema,
    referenceId: referenceIdSchema,
    description: Joi.string().max(500).optional(),
    metadata:    Joi.object().optional(),
  }),

  spend: Joi.object({
    accountId:   Joi.string().uuid().required(),
    amount:      amountSchema,
    referenceId: referenceIdSchema,
    description: Joi.string().max(500).optional(),
    metadata:    Joi.object().optional(),
  }),

  getBalance: Joi.object({
    accountId: Joi.string().uuid().required(),
  }),

  getHistory: Joi.object({
    accountId: Joi.string().uuid().required(),
    limit:     Joi.number().integer().min(1).max(100).default(20),
    offset:    Joi.number().integer().min(0).default(0),
    type:      Joi.string().valid('TOP_UP', 'BONUS', 'SPEND').optional(),
  }),
};

/**
 * Creates a validation middleware for request body.
 */
function validateBody(schemaName) {
  return (req, res, next) => {
    const schema = schemas[schemaName];
    if (!schema) {
      return next(new Error(`Unknown schema: ${schemaName}`));
    }

    const { error, value } = schema.validate(req.body, {
      abortEarly:      false,
      allowUnknown:    false,
      stripUnknown:    true,
    });

    if (error) {
      return res.status(400).json({
        success: false,
        error: {
          code:    'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.details.map((d) => ({
            field:   d.path.join('.'),
            message: d.message,
          })),
        },
      });
    }

    req.body = value; // Use sanitized/coerced values
    return next();
  };
}

/**
 * Validates query params and URL params merged together.
 */
function validateQuery(schemaName) {
  return (req, res, next) => {
    const schema = schemas[schemaName];
    if (!schema) {
      return next(new Error(`Unknown schema: ${schemaName}`));
    }

    const combined = { ...req.params, ...req.query };

    const { error, value } = schema.validate(combined, {
      abortEarly:   false,
      allowUnknown: false,
      stripUnknown: true,
    });

    if (error) {
      return res.status(400).json({
        success: false,
        error: {
          code:    'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.details.map((d) => ({
            field:   d.path.join('.'),
            message: d.message,
          })),
        },
      });
    }

    req.validated = value;
    return next();
  };
}

module.exports = { validateBody, validateQuery };
