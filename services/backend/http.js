// Tiny routing + validation helpers (no framework, to keep the demo service small).

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** Router with ":param" segments. Handlers get a context object; see server.js. */
class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, handler) {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/\/$/, '').replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$'
    );
    this.routes.push({ method, re, keys, handler });
  }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  patch(p, h) { this.add('PATCH', p, h); }
  delete(p, h) { this.add('DELETE', p, h); }

  /** Static segments win over params because routes are matched in registration order. */
  match(method, path) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = path.match(r.re);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      return { handler: r.handler, params };
    }
    return { handler: null, pathMatched };
  }
}

// The gateway authenticates the client and forwards identity in x-gateway-* headers (it strips any
// such headers sent by clients). Writes require an identified client; deletes require admin.
function requireClient(principal) {
  if (!principal) throw new HttpError(401, 'unauthorized', 'Writes require an authenticated client (API key or JWT)');
}
function requireAdmin(principal) {
  requireClient(principal);
  if (principal.tier !== 'admin') throw new HttpError(403, 'forbidden', 'Admin tier required');
}

function str(v, field, { max = 200 } = {}) {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(422, 'validation_error', `${field} is required (string)`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(422, 'validation_error', `${field} must be at most ${max} characters`);
  return s;
}
function num(v, field, { min = -Infinity, max = Infinity } = {}) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
    throw new HttpError(422, 'validation_error', `${field} must be a number between ${min} and ${max}`);
  }
  return n;
}
function int(v, field, opts) {
  const n = num(v, field, opts);
  if (!Number.isInteger(n)) throw new HttpError(422, 'validation_error', `${field} must be an integer`);
  return n;
}

module.exports = { HttpError, Router, requireClient, requireAdmin, str, num, int };
