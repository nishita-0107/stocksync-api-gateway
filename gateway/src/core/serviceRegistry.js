const logger = require('../logger');
const { LoadBalancer } = require('./loadBalancer');
const { UpstreamInstance } = require('./upstreamInstance');

const AUTH_MODES = ['required', 'optional'];

/**
 * "permissions": { "POST /receive": ["supplier", "admin"], "PATCH /*": ["admin"] }
 * Keys are "<METHOD> <upstream path>", where * matches one path segment. Requests that match a rule
 * are only allowed for the listed roles (tiers); requests that match no rule are allowed.
 */
function compilePermissions(service, perms = {}) {
  return Object.entries(perms).map(([key, roles]) => {
    const [method, pattern] = key.trim().split(/\s+/);
    if (!method || !pattern?.startsWith('/') || !Array.isArray(roles)) {
      throw new Error(`Service ${service}: invalid permission "${key}" (expected "METHOD /path": [roles])`);
    }
    const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+') + '/?$');
    return { method: method.toUpperCase(), pattern, re, roles };
  });
}

/** Roles allowed for this request, or null when no rule applies. */
function allowedRoles(service, method, upstreamPath) {
  const path = upstreamPath.split('?')[0];
  const rule = service.permissions.find((r) => r.method === method && r.re.test(path));
  return rule ? rule.roles : null;
}

/** Holds the configured services, their instances, and matches request paths to services. */
class ServiceRegistry {
  constructor(servicesConfig, breakerOptions = {}) {
    this.services = new Map();
    for (const [name, cfg] of Object.entries(servicesConfig)) {
      if (!cfg.prefix || !cfg.prefix.startsWith('/')) throw new Error(`Service ${name}: prefix must start with "/"`);
      const auth = cfg.auth ?? 'required';
      if (!AUTH_MODES.includes(auth)) throw new Error(`Service ${name}: auth must be one of ${AUTH_MODES.join(', ')}`);
      if (!Array.isArray(cfg.instances) || cfg.instances.length === 0) throw new Error(`Service ${name}: no instances`);

      const instances = cfg.instances.map((inst, idx) => {
        const spec = typeof inst === 'string' ? { id: `${name}-${idx + 1}`, url: inst } : inst;
        const instance = new UpstreamInstance({ ...spec, service: name }, breakerOptions);
        instance.breaker.on('stateChange', ({ from, to }) =>
          logger.warn('circuit breaker state change', { service: name, instance: instance.id, from, to })
        );
        return instance;
      });

      this.services.set(name, {
        name,
        prefix: cfg.prefix.replace(/\/+$/, ''),
        auth,
        strategy: cfg.strategy ?? 'round-robin',
        cacheTtlSeconds: cfg.cacheTtlSeconds ?? 0,
        timeoutMs: cfg.timeoutMs ?? 5000,
        retries: cfg.retries ?? 1,
        cost: cfg.cost ?? 1,
        // other services whose cached responses depend on this one (writes here purge their cache too)
        invalidates: Array.isArray(cfg.invalidates) ? cfg.invalidates : [],
        permissions: compilePermissions(name, cfg.permissions),
        instances,
        balancer: new LoadBalancer(cfg.strategy ?? 'round-robin'),
      });
    }
    for (const svc of this.services.values()) {
      for (const dep of svc.invalidates) {
        if (!this.services.has(dep)) throw new Error(`Service ${svc.name}: invalidates unknown service "${dep}"`);
      }
    }
    // Longest prefix first so "/api/a/b" wins over "/api/a".
    this.ordered = [...this.services.values()].sort((a, b) => b.prefix.length - a.prefix.length);
  }

  match(path) {
    return this.ordered.find((s) => path === s.prefix || path.startsWith(s.prefix + '/')) ?? null;
  }

  /** "/api/inventory/ELE-1001?x=1" -> "/ELE-1001?x=1" */
  static upstreamPath(service, originalUrl) {
    const rest = originalUrl.slice(service.prefix.length);
    if (rest === '') return '/';
    return rest.startsWith('/') ? rest : '/' + rest;
  }

  allInstances() {
    return [...this.services.values()].flatMap((s) => s.instances);
  }

  findInstance(id) {
    return this.allInstances().find((i) => i.id === id) ?? null;
  }

  snapshot() {
    return [...this.services.values()].map((s) => ({
      name: s.name,
      prefix: s.prefix,
      auth: s.auth,
      strategy: s.strategy,
      cacheTtlSeconds: s.cacheTtlSeconds,
      timeoutMs: s.timeoutMs,
      retries: s.retries,
      cost: s.cost,
      invalidates: s.invalidates,
      permissions: Object.fromEntries(s.permissions.map((p) => [`${p.method} ${p.pattern}`, p.roles])),
      instances: s.instances.map((i) => i.snapshot()),
    }));
  }
}

module.exports = { ServiceRegistry, allowedRoles };
