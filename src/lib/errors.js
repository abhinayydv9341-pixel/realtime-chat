'use strict';

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const badRequest = (message) => new HttpError(400, 'bad_request', message);
const unauthorized = (message = 'Authentication required') => new HttpError(401, 'unauthorized', message);
const forbidden = (message = 'Forbidden') => new HttpError(403, 'forbidden', message);
const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
const conflict = (message) => new HttpError(409, 'conflict', message);
const tooManyRequests = (retryAfterMs) =>
  new HttpError(429, 'rate_limited', 'Too many messages, slow down', { retryAfterMs });

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict, tooManyRequests };
