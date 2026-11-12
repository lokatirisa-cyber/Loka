import express from 'express';
import { all, get, run } from './db.js';
import {
  AppError,
  assert,
  asyncRoute,
  fail,
  isValidUsername,
  normalizePhone,
  nowIso,
  parseJson,
  publicUser,
  randomCode,
  randomToken,
  rateLimit,
  sha256,
  str,
  uid,
} from './util.js';

const SESSION_DAYS = 90;
const OTP_TTL_MINUTES = 10;
const MAX_OTP_ATTEMPTS = 6;

export const smsConfigured = () =>
  !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER);

async function sendSms(phone, body) {
  if (!smsConfigured()) return false;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const params = new URLSearchParams({ To: phone, From: process.env.TWILIO_FROM_NUMBER, Body: body });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) {
    console.error('[sms] twilio rejected message', res.status);
    return false;
  }
  return true;
}

async function createSession(userId, userAgent) {
  const token = randomToken(32);
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  await run(
    'INSERT INTO sessions (id, user_id, token_hash, user_agent, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [uid('ses_'), userId, sha256(token), String(userAgent || '').slice(0, 200), now.toISOString(), now.toISOString(), expires.toISOString()],
  );
  return { token, expiresAt: expires.toISOString() };
}

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return res.status(401).json({ error: 'Sign in required', code: 'unauthorized' });
    const session = await get('SELECT * FROM sessions WHERE token_hash = ?', [sha256(token)]);
    if (!session) return res.status(401).json({ error: 'Session expired, please sign in again', code: 'unauthorized' });
    if (session.expires_at <= nowIso()) {
      await run('DELETE FROM sessions WHERE id = ?', [session.id]);
      return res.status(401).json({ error: 'Session expired, please sign in again', code: 'unauthorized' });
    }
    const user = await get('SELECT * FROM users WHERE id = ?', [session.user_id]);
    if (!user) return res.status(401).json({ error: 'Account not found', code: 'unauthorized' });
    if (Number(user.is_banned) === 1) {
      return res.status(403).json({ error: 'This account is suspended. Contact support.', code: 'banned' });
    }
    req.user = user;
    req.sessionId = session.id;
    req.authToken = token;
    if (Date.now() - Date.parse(session.last_used_at) > 3_600_000) {
      await run('UPDATE sessions SET last_used_at = ? WHERE id = ?', [nowIso(), session.id]);
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user || Number(req.user.is_admin) !== 1) {
    return res.status(403).json({ error: 'Administrator access required', code: 'forbidden' });
  }
  return next();
}

export async function userById(id) {
  return get('SELECT * FROM users WHERE id = ?', [id]);
}

export function authRoutes() {
  const router = express.Router();

  router.post(
    '/request-otp',
    rateLimit({ windowMs: 10 * 60_000, max: 8, scope: 'otp-request' }),
    asyncRoute(async (req, res) => {
      const phone = normalizePhone(req.body?.phone);
      assert(phone, 400, 'Enter a valid phone number in international format', 'invalid_phone');
      const existing = await get('SELECT id, is_banned FROM users WHERE phone = ?', [phone]);
      if (existing && Number(existing.is_banned) === 1) {
        fail(403, 'This account is suspended. Contact support.', 'banned');
      }

      const code = randomCode(6);
      const now = new Date();
      const expires = new Date(now.getTime() + OTP_TTL_MINUTES * 60_000).toISOString();
      await run('DELETE FROM otp_codes WHERE phone = ?', [phone]);
      await run(
        'INSERT INTO otp_codes (id, phone, code_hash, attempts, consumed, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [uid('otp_'), phone, sha256(`${phone}:${code}`), 0, 0, expires, now.toISOString()],
      );

      const delivered = await sendSms(phone, `YOU.AI verification code: ${code}. It expires in ${OTP_TTL_MINUTES} minutes.`);
      const devMode = !delivered;
      res.json({
        ok: true,
        phone,
        exists: !!existing,
        smsDelivered: delivered,
        expiresAt: expires,
        // Without an SMS provider the code is returned so the app remains usable.
        // Configure TWILIO_* environment variables to deliver codes by SMS instead.
        devCode: devMode ? code : undefined,
        hint: devMode ? 'No SMS provider configured — the code is shown here.' : undefined,
      });
    }),
  );

  router.post(
    '/verify-otp',
    rateLimit({ windowMs: 10 * 60_000, max: 20, scope: 'otp-verify' }),
    asyncRoute(async (req, res) => {
      const phone = normalizePhone(req.body?.phone);
      const code = String(req.body?.code || '').replace(/\s/g, '');
      assert(phone, 400, 'Enter a valid phone number', 'invalid_phone');
      assert(/^\d{6}$/.test(code), 400, 'Enter the 6-digit code', 'invalid_code');

      const otp = await get('SELECT * FROM otp_codes WHERE phone = ? ORDER BY created_at DESC LIMIT 1', [phone]);
      assert(otp, 400, 'Request a new verification code', 'otp_missing');
      assert(Number(otp.consumed) === 0, 400, 'This code was already used', 'otp_used');
      assert(otp.expires_at > nowIso(), 400, 'This code expired, request a new one', 'otp_expired');
      assert(Number(otp.attempts) < MAX_OTP_ATTEMPTS, 429, 'Too many attempts, request a new code', 'otp_locked');
      if (otp.code_hash !== sha256(`${phone}:${code}`)) {
        await run('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', [otp.id]);
        fail(400, 'Incorrect code', 'otp_invalid');
      }
      await run('UPDATE otp_codes SET consumed = 1 WHERE id = ?', [otp.id]);

      let user = await get('SELECT * FROM users WHERE phone = ?', [phone]);
      let isNew = false;

      if (!user) {
        const total = await get('SELECT COUNT(*) AS n FROM users');
        const firstUser = Number(total?.n || 0) === 0;
        const username = String(req.body?.username || '').trim().toLowerCase();
        const displayName = String(req.body?.displayName || '').trim();
        assert(isValidUsername(username), 400, 'Pick a username: 3-20 letters, numbers, dot or underscore', 'invalid_username');
        assert(displayName.length >= 2 && displayName.length <= 40, 400, 'Enter your display name', 'invalid_name');
        const taken = await get('SELECT id FROM users WHERE username = ?', [username]);
        assert(!taken, 409, 'That username is taken', 'username_taken');

        const isAdmin = firstUser || phone === normalizePhone(process.env.ADMIN_PHONE || '') ? 1 : 0;
        const id = uid('usr_');
        const createdAt = nowIso();
        await run(
          'INSERT INTO users (id, phone, username, display_name, avatar_url, bio, locale, is_admin, is_banned, privacy, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id, phone, username, displayName, null, '', String(req.body?.locale || 'en').slice(0, 5), isAdmin, 0, '{}', createdAt, createdAt],
        );
        user = await get('SELECT * FROM users WHERE id = ?', [id]);
        isNew = true;
      } else if (req.body?.username) {
        const username = String(req.body.username).trim().toLowerCase();
        if (isValidUsername(username) && username !== user.username) {
          const taken = await get('SELECT id FROM users WHERE username = ? AND id <> ?', [username, user.id]);
          if (!taken) await run('UPDATE users SET username = ? WHERE id = ?', [username, user.id]);
        }
        if (req.body?.displayName) {
          const displayName = String(req.body.displayName).trim().slice(0, 40);
          if (displayName.length >= 2) await run('UPDATE users SET display_name = ? WHERE id = ?', [displayName, user.id]);
        }
        user = await get('SELECT * FROM users WHERE id = ?', [user.id]);
      }

      const session = await createSession(user.id, req.headers['user-agent']);
      res.json({ ok: true, token: session.token, expiresAt: session.expiresAt, user: publicUser(user, user), isNew });
    }),
  );

  router.get(
    '/me',
    requireAuth,
    asyncRoute(async (req, res) => {
      res.json({ user: publicUser(req.user, req.user) });
    }),
  );

  router.post(
    '/logout',
    requireAuth,
    asyncRoute(async (req, res) => {
      await run('DELETE FROM sessions WHERE id = ?', [req.sessionId]);
      res.json({ ok: true });
    }),
  );

  router.post(
    '/logout-all',
    requireAuth,
    asyncRoute(async (req, res) => {
      await run('DELETE FROM sessions WHERE user_id = ?', [req.user.id]);
      res.json({ ok: true });
    }),
  );

  router.get(
    '/sessions',
    requireAuth,
    asyncRoute(async (req, res) => {
      const rows = await all('SELECT id, user_agent, created_at, last_used_at, expires_at FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC', [req.user.id]);
      res.json({ sessions: rows.map((r) => ({ id: r.id, userAgent: r.user_agent, createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: r.expires_at, current: r.id === req.sessionId })) });
    }),
  );

  return router;
}

export function settingsPayload(user) {
  const privacy = parseJson(user.privacy, {}) || {};
  return {
    privacy: {
      hideLastSeen: privacy.hideLastSeen === true,
      hidePhone: privacy.hidePhone !== false,
      allowFriendRequests: privacy.allowFriendRequests !== false,
      aiDisclosureRequired: privacy.aiDisclosureRequired !== false,
    },
  };
}

export { AppError, str };
