const express = require('express');
const { sendError } = require('../utils');

/** POST /auth/token  (X-API-Key: <key>)  ->  short-lived JWT */
function authRoutes({ auth, rateLimiter, config }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.locals.route = 'auth';
    next();
  });

  router.post('/token', rateLimiter.middleware({ cost: 1 }), async (req, res) => {
    const key = req.headers['x-api-key'];
    if (!key) return sendError(res, 400, 'bad_request', 'X-API-Key header required');
    const principal = auth.resolveApiKey(key);
    if (!principal) return sendError(res, 401, 'unauthorized', 'Invalid API key');
    res.json({
      accessToken: auth.issueToken(principal),
      tokenType: 'Bearer',
      expiresIn: config.jwtTtlSeconds,
      tier: principal.tier,
    });
  });

  return router;
}

module.exports = { authRoutes };
