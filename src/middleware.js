'use strict';

const { HttpError, badRequest, unauthorized, tooManyRequests } = require('./lib/errors');

function requireAuth(auth) {
  return async (req, res, next) => {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) return next(unauthorized());
    try {
      req.user = await auth.authenticate(token);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Applies a SlidingWindowRateLimiter per authenticated user and sets standard headers. */
function rateLimit(limiter, keyFn) {
  return async (req, res, next) => {
    try {
      const verdict = await limiter.consume(keyFn(req));
      res.set('X-RateLimit-Limit', String(limiter.limit));
      res.set('X-RateLimit-Remaining', String(verdict.remaining));
      if (!verdict.allowed) {
        res.set('Retry-After', String(Math.ceil(verdict.retryAfterMs / 1000)));
        return next(tooManyRequests(verdict.retryAfterMs));
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Parses a positive integer route parameter. */
function idParam(req, name) {
  const value = Number(req.params[name]);
  if (!Number.isSafeInteger(value) || value < 1) throw badRequest(`${name} must be a positive integer`);
  return value;
}

function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'not_found', message: `No route for ${req.method} ${req.path}` } });
}

function errorHandler(log) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (err instanceof HttpError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'bad_request', message: 'Malformed JSON body' } });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body too large' } });
    }
    log.error('unhandled error', err);
    res.status(500).json({ error: { code: 'internal', message: 'Internal server error' } });
  };
}

module.exports = { requireAuth, rateLimit, idParam, notFoundHandler, errorHandler };
