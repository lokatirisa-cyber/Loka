import crypto from 'node:crypto';

export const nowIso = () => new Date().toISOString();

export const uid = (prefix = '') => `${prefix}${crypto.randomBytes(12).toString('hex')}`;

export const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

export const randomCode = (digits = 6) => {
  let out = '';
  for (let i = 0; i < digits; i += 1) out += String(crypto.randomInt(0, 10));
  return out;
};

export class AppError extends Error {
  constructor(status, message, code = 'error', extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const fail = (status, message, code, extra) => {
  throw new AppError(status, message, code, extra);
};

export const assert = (condition, status, message, code, extra) => {
  if (!condition) throw new AppError(status, message, code, extra);
};

/** Normalise a phone number to E.164-ish form: +<digits>. */
export function normalizePhone(raw) {
  const cleaned = String(raw || '').replace(/[\s\-().]/g, '');
  const match = /^\+?(\d{8,15})$/.exec(cleaned);
  if (!match) return null;
  return `+${match[1]}`;
}

export const isValidUsername = (value) => /^[a-zA-Z0-9_.]{3,20}$/.test(String(value || ''));

export const isValidId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(value);

export function str(value, { min = 0, max = 4000, field = 'value', trim = true } = {}) {
  let out = typeof value === 'string' ? value : '';
  if (trim) out = out.trim();
  if (out.length < min) fail(400, `${field} is too short`, 'invalid_input');
  if (out.length > max) fail(400, `${field} is too long`, 'invalid_input');
  return out;
}

export function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export const bool = (value) => value === true || value === 1 || value === '1' || value === 'true';

/** Simple in-memory sliding-window rate limiter. */
const buckets = new Map();

export function rateLimit({ windowMs = 60_000, max = 60, scope = 'default', keyFn } = {}) {
  return (req, res, next) => {
    const key = `${scope}:${keyFn ? keyFn(req) : req.ip}`;
    const now = Date.now();
    const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= max) {
      const retryAfter = Math.ceil((windowMs - (now - hits[0])) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests, slow down a little.', code: 'rate_limited', retryAfter });
    }
    hits.push(now);
    buckets.set(key, hits);
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) {
        if (!v.some((t) => now - t < windowMs)) buckets.delete(k);
      }
    }
    return next();
  };
}

/** Wraps an async route handler so rejections reach the express error handler. */
export const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

export function publicUser(row, viewer = null) {
  if (!row) return null;
  const privacy = parseJson(row.privacy, {}) || {};
  const hideLastSeen = viewer && viewer.id !== row.id && privacy.hideLastSeen === true;
  const hidePhone = viewer && viewer.id !== row.id && privacy.hidePhone !== false;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name ?? row.displayName,
    avatarUrl: row.avatar_url ?? row.avatarUrl ?? null,
    bio: row.bio || '',
    locale: row.locale || 'en',
    isAdmin: bool(row.is_admin ?? row.isAdmin),
    isBanned: bool(row.is_banned ?? row.isBanned),
    phone: hidePhone ? null : row.phone,
    online: bool(row.online),
    lastSeen: hideLastSeen ? null : row.last_seen ?? row.lastSeen ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null,
  };
}

export function corsHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
}
