import fs from 'node:fs';
import path from 'node:path';

/**
 * Portable SQL data layer.
 *
 * - When DATABASE_URL / POSTGRES_URL / SUPABASE_DB_URL is present the app uses a real
 *   PostgreSQL database (Supabase project connection string) through `pg`.
 * - Otherwise it falls back to an embedded SQLite database (sql.js, no native build) so the
 *   app runs and can be verified without external credentials.
 *
 * SQL written by the app sticks to a portable subset: TEXT ids/timestamps, INTEGER flags,
 * `?` placeholders (translated to $1..$n for Postgres) and `ON CONFLICT ... DO UPDATE`.
 */

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'youai.db');

let mode = 'sqlite';
let sqljs = null;
let sqlDb = null;
let pool = null;
let persistTimer = null;
let persistDirty = false;

export const dbMode = () => mode;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  bio TEXT,
  locale TEXT DEFAULT 'en',
  is_admin INTEGER DEFAULT 0,
  is_banned INTEGER DEFAULT 0,
  privacy TEXT DEFAULT '{}',
  last_seen TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER DEFAULT 0,
  consumed INTEGER DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS friendships (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL,
  addressee_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_friendships_pair ON friendships (requester_id, addressee_id);

CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY,
  blocker_id TEXT NOT NULL,
  blocked_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_pair ON blocks (blocker_id, blocked_id);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT,
  avatar_url TEXT,
  created_by TEXT,
  ai_persona_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT DEFAULT 'member',
  mode TEXT DEFAULT 'manual',
  last_read_at TEXT,
  archived INTEGER DEFAULT 0,
  muted INTEGER DEFAULT 0,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  filename TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  sender_id TEXT,
  sender_kind TEXT DEFAULT 'user',
  kind TEXT DEFAULT 'text',
  body TEXT,
  media_id TEXT,
  reply_to TEXT,
  translated TEXT,
  edited_at TEXT,
  deleted_at TEXT,
  ai_persona_id TEXT,
  ai_generated INTEGER DEFAULT 0,
  ai_disclosed INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS message_reads (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS ai_personas (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar_url TEXT,
  tagline TEXT,
  system_prompt TEXT,
  tone TEXT,
  style TEXT,
  visibility TEXT DEFAULT 'private',
  is_published INTEGER DEFAULT 0,
  is_blocked INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_memories (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT DEFAULT 'manual',
  approved INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_documents (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  caller_id TEXT NOT NULL,
  callee_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  type TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  host_id TEXT NOT NULL,
  state TEXT DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS game_players (
  game_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  score INTEGER DEFAULT 0,
  is_ai INTEGER DEFAULT 0,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (game_id, user_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT DEFAULT 'open',
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT DEFAULT '{}',
  read_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_models (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  provider TEXT NOT NULL,
  base_url TEXT,
  model TEXT NOT NULL,
  is_default INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_settings (
  skey TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function schedulePersist() {
  if (mode !== 'sqlite') return;
  persistDirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!persistDirty || !sqlDb) return;
    persistDirty = false;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${DB_FILE}.tmp`;
      fs.writeFileSync(tmp, Buffer.from(sqlDb.export()));
      fs.renameSync(tmp, DB_FILE);
    } catch (err) {
      console.error('[db] persist failed', err.message);
    }
  }, 250);
  if (typeof persistTimer.unref === 'function') persistTimer.unref();
}

const translatePlaceholders = (sql) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${(i += 1)}`);
};

export async function initDb() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_DB_URL;
  if (url) {
    const { default: pg } = await import('pg');
    pool = new pg.Pool({
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX || 6),
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
    });
    await pool.query('SELECT 1');
    mode = 'postgres';
    console.log('[db] postgres driver ready');
  } else {
    const { default: initSqlJs } = await import('sql.js');
    const SQL = await initSqlJs({
      locateFile: (file) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
    });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    sqlDb = fs.existsSync(DB_FILE) ? new SQL.Database(fs.readFileSync(DB_FILE)) : new SQL.Database();
    sqljs = SQL;
    mode = 'sqlite';
    console.log('[db] embedded sqlite driver ready at', DB_FILE);
  }
  await exec(SCHEMA);
  return mode;
}

export async function exec(sql) {
  if (mode === 'postgres') {
    await pool.query(sql);
    return;
  }
  sqlDb.exec(sql);
  schedulePersist();
}

export async function all(sql, params = []) {
  if (mode === 'postgres') {
    const result = await pool.query(translatePlaceholders(sql), params);
    return result.rows;
  }
  const stmt = sqlDb.prepare(sql);
  try {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

export async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0];
}

export async function run(sql, params = []) {
  if (mode === 'postgres') {
    const result = await pool.query(translatePlaceholders(sql), params);
    return { changes: result.rowCount };
  }
  const stmt = sqlDb.prepare(sql);
  try {
    stmt.bind(params);
    stmt.step();
  } finally {
    stmt.free();
  }
  schedulePersist();
  return { changes: sqlDb.getRowsModified() };
}

/** Runs a callback inside a transaction (best effort across drivers). */
export async function tx(fn) {
  if (mode === 'postgres') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const scoped = {
        run: async (sql, params = []) => {
          const r = await client.query(translatePlaceholders(sql), params);
          return { changes: r.rowCount };
        },
        all: async (sql, params = []) => (await client.query(translatePlaceholders(sql), params)).rows,
        get: async (sql, params = []) => (await client.query(translatePlaceholders(sql), params)).rows[0],
      };
      const result = await fn(scoped);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  sqlDb.exec('BEGIN');
  try {
    const result = await fn({ run, all, get });
    sqlDb.exec('COMMIT');
    schedulePersist();
    return result;
  } catch (err) {
    sqlDb.exec('ROLLBACK');
    throw err;
  }
}

export async function seedDefaults() {
  const models = [
    { label: 'Llama 3.3 70B (Meta)', provider: 'openai-compatible', model: 'meta-llama/Llama-3.3-70B-Instruct' },
    { label: 'Llama 3.1 8B (Meta, fast)', provider: 'openai-compatible', model: 'meta-llama/Llama-3.1-8B-Instruct' },
    { label: 'GPT-4o mini', provider: 'openai-compatible', model: 'gpt-4o-mini' },
  ];
  const existing = await get('SELECT id FROM ai_models LIMIT 1');
  if (!existing) {
    const now = new Date().toISOString();
    for (let i = 0; i < models.length; i += 1) {
      await run(
        'INSERT INTO ai_models (id, label, provider, base_url, model, is_default, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [`mdl_${models[i].model.replace(/[^a-z0-9]/gi, '').slice(0, 20)}`, models[i].label, models[i].provider, null, models[i].model, i === 0 ? 1 : 0, 1, now],
      );
    }
  }
  const settings = await get('SELECT skey FROM app_settings WHERE skey = ?', ['platform']);
  if (!settings) {
    await run('INSERT INTO app_settings (skey, value) VALUES (?, ?)', [
      'platform',
      JSON.stringify({ name: 'YOU.AI', tagline: 'Your AI, your friends, your world.', registrationOpen: true }),
    ]);
  }
}

export async function closeDb() {
  if (persistTimer) clearTimeout(persistTimer);
  if (mode === 'sqlite' && sqlDb) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, Buffer.from(sqlDb.export()));
    } catch (err) {
      console.error('[db] final persist failed', err.message);
    }
    sqlDb.close();
  }
  if (mode === 'postgres' && pool) await pool.end();
}
