const jwt = require('jsonwebtoken');
const { sha256, sendError } = require('../utils');

class AuthError extends Error {}

/**
 * Authentication: `X-API-Key: <key>` or `Authorization: Bearer <jwt>`.
 * API keys come from configuration (API_KEYS env var). Only their sha256 hashes are kept in
 * memory, and lookups compare hashes, so the raw keys are not held after startup.
 * JWTs are issued by POST /auth/token and are valid until they expire.
 */
function createAuth({ config }) {
  const byHash = new Map(
    config.apiKeys.map(({ key, tier, name }) => [sha256(key), Object.freeze({ id: name, name, tier })])
  );

  function resolveApiKey(rawKey) {
    return byHash.get(sha256(String(rawKey))) ?? null;
  }

  function authenticate(req) {
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) {
      try {
        const claims = jwt.verify(header.slice(7), config.jwtSecret, { algorithms: ['HS256'] });
        return { id: claims.sub, name: claims.sub, tier: claims.tier, via: 'jwt' };
      } catch (err) {
        throw new AuthError(err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token');
      }
    }

    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      const principal = resolveApiKey(apiKey);
      if (!principal) throw new AuthError('Invalid API key');
      return { ...principal, via: 'api-key' };
    }
    return null;
  }

  const cache = {};
  /** mode: 'required' | 'optional' | 'admin' */
  function middleware(mode) {
    if (cache[mode]) return cache[mode];
    cache[mode] = (req, res, next) => {
      let principal;
      try {
        principal = authenticate(req);
      } catch (err) {
        if (err instanceof AuthError) return sendError(res, 401, 'unauthorized', err.message);
        throw err;
      }
      if (!principal && mode !== 'optional') {
        return sendError(res, 401, 'unauthorized', 'Provide X-API-Key or Authorization: Bearer <token>');
      }
      if (mode === 'admin' && principal.tier !== 'admin') {
        return sendError(res, 403, 'forbidden', 'Admin tier required');
      }
      req.principal = principal;
      next();
    };
    return cache[mode];
  }

  function issueToken(principal) {
    return jwt.sign({ tier: principal.tier }, config.jwtSecret, {
      algorithm: 'HS256',
      subject: principal.id,
      expiresIn: config.jwtTtlSeconds,
      issuer: 'smart-api-gateway',
    });
  }

  return { middleware, authenticate, resolveApiKey, issueToken };
}

module.exports = { createAuth, AuthError };
