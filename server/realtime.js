import { WebSocketServer } from 'ws';
import { all, get, run } from './db.js';
import { nowIso, sha256, uid } from './util.js';

/** userId -> Set<WebSocket> */
const sockets = new Map();

export const isOnline = (userId) => sockets.has(userId) && sockets.get(userId).size > 0;

function addSocket(userId, ws) {
  if (!sockets.has(userId)) sockets.set(userId, new Set());
  sockets.get(userId).add(ws);
}

function removeSocket(userId, ws) {
  const set = sockets.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) sockets.delete(userId);
}

export function sendToUser(userId, event) {
  const set = sockets.get(userId);
  if (!set) return 0;
  const payload = JSON.stringify(event);
  let sent = 0;
  for (const ws of set) {
    if (ws.readyState === 1) {
      ws.send(payload);
      sent += 1;
    }
  }
  return sent;
}

export function sendToUsers(userIds, event, exceptUserId = null) {
  for (const id of userIds) {
    if (id && id !== exceptUserId) sendToUser(id, event);
  }
}

export async function conversationMemberIds(conversationId) {
  const rows = await all('SELECT user_id FROM conversation_members WHERE conversation_id = ?', [conversationId]);
  return rows.map((r) => r.user_id);
}

/** Persist + push an in-app notification. */
export async function notifyUser(userId, type, payload = {}) {
  const row = {
    id: uid('ntf_'),
    user_id: userId,
    type,
    payload: JSON.stringify(payload),
    created_at: nowIso(),
  };
  await run('INSERT INTO notifications (id, user_id, type, payload, read_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    row.id,
    row.user_id,
    row.type,
    row.payload,
    null,
    row.created_at,
  ]);
  sendToUser(userId, { type: 'notification', notification: { id: row.id, type, payload, createdAt: row.created_at } });
  return row;
}

export async function contactsOf(userId) {
  const rows = await all(
    `SELECT DISTINCT other.user_id AS id FROM conversation_members mine
       JOIN conversation_members other ON other.conversation_id = mine.conversation_id
      WHERE mine.user_id = ? AND other.user_id <> ?`,
    [userId, userId],
  );
  const friends = await all(
    `SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END AS id
       FROM friendships WHERE status = 'accepted' AND (requester_id = ? OR addressee_id = ?)`,
    [userId, userId, userId],
  );
  return [...new Set([...rows.map((r) => r.id), ...friends.map((r) => r.id)])];
}

export async function attachRealtime(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });

  server.on('upgrade', async (req, socket, head) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      const token = url.searchParams.get('token') || '';
      const session = await get('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?', [sha256(token)]);
      if (!session || session.expires_at <= nowIso()) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.userId = session.user_id;
        wss.emit('connection', ws, req);
      });
    } catch {
      socket.destroy();
    }
  });

  wss.on('connection', async (ws) => {
    const userId = ws.userId;
    addSocket(userId, ws);
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    await run('UPDATE users SET last_seen = ? WHERE id = ?', [nowIso(), userId]);
    const contacts = await contactsOf(userId);
    sendToUsers(contacts, { type: 'presence', userId, online: true, lastSeen: nowIso() }, userId);
    ws.send(JSON.stringify({ type: 'ready', userId, online: contacts.filter((id) => isOnline(id)) }));

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;
      try {
        if (msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', at: Date.now() }));
          return;
        }

        if (msg.type === 'typing') {
          const member = await get('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [
            String(msg.conversationId || ''),
            userId,
          ]);
          if (!member) return;
          const ids = await conversationMemberIds(msg.conversationId);
          sendToUsers(
            ids,
            { type: 'typing', conversationId: msg.conversationId, userId, isTyping: !!msg.isTyping },
            userId,
          );
          return;
        }

        if (msg.type === 'read') {
          const member = await get('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [
            String(msg.conversationId || ''),
            userId,
          ]);
          if (!member) return;
          const at = nowIso();
          if (msg.messageId) {
            await run(
              'INSERT INTO message_reads (message_id, user_id, read_at) VALUES (?, ?, ?) ON CONFLICT (message_id, user_id) DO UPDATE SET read_at = ?',
              [String(msg.messageId), userId, at, at],
            );
          }
          await run('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?', [
            at,
            msg.conversationId,
            userId,
          ]);
          const ids = await conversationMemberIds(msg.conversationId);
          sendToUsers(
            ids,
            { type: 'read', conversationId: msg.conversationId, userId, messageId: msg.messageId || null, at },
            userId,
          );
          return;
        }

        // WebRTC signaling relay (offer / answer / ice / hangup / decline)
        if (msg.type === 'call') {
          const convId = String(msg.conversationId || '');
          const member = await get('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [
            convId,
            userId,
          ]);
          if (!member) return;
          const ids = await conversationMemberIds(convId);
          const targets = msg.to ? [String(msg.to)].filter((id) => ids.includes(id)) : ids.filter((id) => id !== userId);
          const event = {
            type: 'call',
            action: msg.action,
            conversationId: convId,
            from: userId,
            kind: msg.kind || 'audio',
            callId: msg.callId || null,
            payload: msg.payload || null,
          };
          sendToUsers(targets, event, userId);
          return;
        }

        if (msg.type === 'game') {
          const convId = String(msg.conversationId || '');
          if (!convId) return;
          const member = await get('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [
            convId,
            userId,
          ]);
          if (!member) return;
          const ids = await conversationMemberIds(convId);
          sendToUsers(ids, { type: 'game', conversationId: convId, from: userId, payload: msg.payload || null }, userId);
        }
      } catch (err) {
        console.error('[ws] handler error', err.message);
      }
    });

    ws.on('close', async () => {
      removeSocket(userId, ws);
      if (!isOnline(userId)) {
        const at = nowIso();
        await run('UPDATE users SET last_seen = ? WHERE id = ?', [at, userId]);
        const contacts = await contactsOf(userId);
        sendToUsers(contacts, { type: 'presence', userId, online: false, lastSeen: at }, userId);
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, 30_000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}
