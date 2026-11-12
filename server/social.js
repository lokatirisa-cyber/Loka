import express from 'express';
import { all, get, run } from './db.js';
import { requireAuth } from './auth.js';
import { conversationMemberIds, notifyUser, sendToUser, sendToUsers, isOnline } from './realtime.js';
import {
  assert,
  asyncRoute,
  bool,
  fail,
  isValidId,
  nowIso,
  parseJson,
  publicUser,
  rateLimit,
  str,
  uid,
} from './util.js';

const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

/* ------------------------------------------------------------------ helpers */

export async function memberOf(conversationId, userId) {
  return get('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [conversationId, userId]);
}

export async function requireMember(conversationId, userId) {
  const member = await memberOf(conversationId, userId);
  if (!member) fail(403, 'You are not part of this conversation', 'forbidden');
  return member;
}

export async function isBlockedBetween(a, b) {
  const row = await get(
    'SELECT id FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)',
    [a, b, b, a],
  );
  return !!row;
}

export async function conversationMemberProfiles(conversationId) {
  const rows = await all(
    `SELECT u.*, m.role, m.mode, m.last_read_at, m.archived, m.muted, m.joined_at AS member_since
       FROM conversation_members m JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id = ?`,
    [conversationId],
  );
  return rows.map((r) => ({
    ...publicUser(r, null),
    role: r.role,
    mode: r.mode,
    lastReadAt: r.last_read_at,
    archived: bool(r.archived),
    muted: bool(r.muted),
    joinedAt: r.member_since,
  }));
}

export async function serializeMessage(row, viewerId) {
  if (!row) return null;
  const reactions = await all('SELECT user_id, emoji FROM message_reactions WHERE message_id = ?', [row.id]);
  const sender = row.sender_id ? await get('SELECT id, username, display_name, avatar_url FROM users WHERE id = ?', [row.sender_id]) : null;
  const persona = row.ai_persona_id ? await get('SELECT id, name, avatar_url FROM ai_personas WHERE id = ?', [row.ai_persona_id]) : null;
  const replyRow = row.reply_to ? await get('SELECT id, body, sender_id, kind FROM messages WHERE id = ?', [row.reply_to]) : null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    senderKind: row.sender_kind,
    sender: sender
      ? { id: sender.id, username: sender.username, displayName: sender.display_name, avatarUrl: sender.avatar_url }
      : null,
    kind: row.kind,
    body: Number(row.deleted_at ? 1 : 0) === 1 ? null : row.body,
    mediaUrl: row.media_id && !row.deleted_at ? `/api/media/${row.media_id}` : null,
    replyTo: replyRow ? { id: replyRow.id, body: replyRow.body ? String(replyRow.body).slice(0, 140) : null, senderId: replyRow.sender_id } : null,
    reactions: reactions.map((r) => ({ userId: r.user_id, emoji: r.emoji })),
    translated: parseJson(row.translated, {}) || {},
    editedAt: row.edited_at || null,
    deletedAt: row.deleted_at || null,
    aiGenerated: bool(row.ai_generated),
    aiDisclosed: bool(row.ai_disclosed),
    persona: persona ? { id: persona.id, name: persona.name, avatarUrl: persona.avatar_url } : null,
    createdAt: row.created_at,
    mine: viewerId ? row.sender_id === viewerId : false,
  };
}

async function touchConversation(conversationId) {
  await run('UPDATE conversations SET updated_at = ? WHERE id = ?', [nowIso(), conversationId]);
}

export async function broadcastMessage(conversationId, message, exceptUserId) {
  const ids = await conversationMemberIds(conversationId);
  sendToUsers(ids, { type: 'message', message }, exceptUserId);
  return ids;
}

export async function insertMessage({
  conversationId,
  senderId,
  senderKind = 'user',
  kind = 'text',
  body = '',
  mediaId = null,
  replyTo = null,
  aiPersonaId = null,
  aiGenerated = false,
  aiDisclosed = false,
}) {
  const row = {
    id: uid('msg_'),
    conversation_id: conversationId,
    sender_id: senderId,
    sender_kind: senderKind,
    kind,
    body,
    media_id: mediaId,
    reply_to: replyTo,
    translated: '{}',
    edited_at: null,
    deleted_at: null,
    ai_persona_id: aiPersonaId,
    ai_generated: aiGenerated ? 1 : 0,
    ai_disclosed: aiDisclosed ? 1 : 0,
    created_at: nowIso(),
  };
  await run(
    `INSERT INTO messages (id, conversation_id, sender_id, sender_kind, kind, body, media_id, reply_to, translated, edited_at, deleted_at, ai_persona_id, ai_generated, ai_disclosed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.conversation_id, row.sender_id, row.sender_kind, row.kind, row.body, row.media_id, row.reply_to, row.translated, null, null, row.ai_persona_id, row.ai_generated, row.ai_disclosed, row.created_at],
  );
  await touchConversation(conversationId);
  return row;
}

async function assertNotBlocked(userId, otherId) {
  assert(userId !== otherId, 400, 'You cannot do that with yourself', 'invalid_target');
  if (await isBlockedBetween(userId, otherId)) fail(403, 'This connection is blocked', 'blocked');
}

export async function findOrCreateDm(userId, otherId) {
  const existing = await get(
    `SELECT c.id FROM conversations c
       JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = ?
       JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = ?
      WHERE c.type = 'dm' LIMIT 1`,
    [userId, otherId],
  );
  if (existing) return existing.id;
  const id = uid('cnv_');
  const now = nowIso();
  await run('INSERT INTO conversations (id, type, title, avatar_url, created_by, ai_persona_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    id, 'dm', null, null, userId, null, now, now,
  ]);
  await run('INSERT INTO conversation_members (conversation_id, user_id, role, mode, last_read_at, archived, muted, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, userId, 'member', 'manual', now, 0, 0, now]);
  await run('INSERT INTO conversation_members (conversation_id, user_id, role, mode, last_read_at, archived, muted, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, otherId, 'member', 'manual', null, 0, 0, now]);
  return id;
}

async function conversationSummary(conversation, viewerId) {
  const members = await conversationMemberProfiles(conversation.id);
  const others = members.filter((m) => m.id !== viewerId);
  const lastRow = await get('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', [conversation.id]);
  const myMember = members.find((m) => m.id === viewerId);
  const unreadRow = await get(
    'SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_id <> ? AND (created_at > ? OR ? IS NULL) AND deleted_at IS NULL',
    [conversation.id, viewerId, myMember?.lastReadAt || '', myMember?.lastReadAt || null],
  );
  let title = conversation.title;
  let avatarUrl = conversation.avatar_url;
  if (conversation.type === 'dm' && others[0]) {
    title = others[0].displayName;
    avatarUrl = others[0].avatarUrl;
  }
  let persona = null;
  if (conversation.ai_persona_id) {
    const p = await get('SELECT id, name, avatar_url FROM ai_personas WHERE id = ?', [conversation.ai_persona_id]);
    if (p) {
      persona = { id: p.id, name: p.name, avatarUrl: p.avatar_url };
      if (!title) title = p.name;
      if (!avatarUrl) avatarUrl = p.avatar_url;
    }
  }
  return {
    id: conversation.id,
    type: conversation.type,
    title: title || 'Conversation',
    avatarUrl: avatarUrl || null,
    members,
    otherMember: others[0] || null,
    persona,
    mode: myMember?.mode || 'manual',
    archived: !!myMember?.archived,
    muted: !!myMember?.muted,
    unread: Number(unreadRow?.n || 0),
    lastMessage: lastRow ? await serializeMessage(lastRow, viewerId) : null,
    updatedAt: conversation.updated_at,
  };
}

/* --------------------------------------------------------------- endpoints */

export function socialRoutes() {
  const router = express.Router();
  router.use(requireAuth);

  /* ----------------------------------------------------------- profile */

  router.patch(
    '/users/me',
    asyncRoute(async (req, res) => {
      const updates = [];
      const params = [];
      if (typeof req.body?.displayName === 'string') {
        const name = str(req.body.displayName, { min: 2, max: 40, field: 'display name' });
        updates.push('display_name = ?');
        params.push(name);
      }
      if (typeof req.body?.username === 'string') {
        const username = req.body.username.trim().toLowerCase();
        assert(/^[a-zA-Z0-9_.]{3,20}$/.test(username), 400, 'Username must be 3-20 letters, numbers, dot or underscore', 'invalid_username');
        const taken = await get('SELECT id FROM users WHERE username = ? AND id <> ?', [username, req.user.id]);
        assert(!taken, 409, 'That username is taken', 'username_taken');
        updates.push('username = ?');
        params.push(username);
      }
      if (typeof req.body?.bio === 'string') {
        updates.push('bio = ?');
        params.push(str(req.body.bio, { max: 280, field: 'bio' }));
      }
      if (typeof req.body?.locale === 'string' && ['en', 'fr', 'ar'].includes(req.body.locale)) {
        updates.push('locale = ?');
        params.push(req.body.locale);
      }
      if (req.body?.privacy && typeof req.body.privacy === 'object') {
        const current = parseJson(req.user.privacy, {}) || {};
        const next = { ...current };
        for (const key of ['hideLastSeen', 'hidePhone', 'allowFriendRequests', 'aiDisclosureRequired']) {
          if (typeof req.body.privacy[key] === 'boolean') next[key] = req.body.privacy[key];
        }
        updates.push('privacy = ?');
        params.push(JSON.stringify(next));
      }
      if (!updates.length) fail(400, 'Nothing to update', 'no_changes');
      params.push(req.user.id);
      await run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
      const fresh = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
      res.json({ ok: true, user: publicUser(fresh, fresh) });
    }),
  );

  router.post(
    '/users/me/avatar',
    asyncRoute(async (req, res) => {
      const mediaId = String(req.body?.mediaId || '');
      const media = await get('SELECT * FROM media WHERE id = ? AND owner_id = ?', [mediaId, req.user.id]);
      assert(media, 400, 'Upload an image first', 'media_missing');
      await run('UPDATE users SET avatar_url = ? WHERE id = ?', [`/api/media/${media.id}`, req.user.id]);
      const fresh = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
      res.json({ ok: true, user: publicUser(fresh, fresh) });
    }),
  );

  router.get(
    '/users/search',
    asyncRoute(async (req, res) => {
      const q = String(req.query.q || '').trim().toLowerCase();
      assert(q.length >= 2, 400, 'Type at least 2 characters', 'invalid_query');
      const rows = await all(
        `SELECT * FROM users WHERE is_banned = 0 AND id <> ? AND (LOWER(username) LIKE ? OR LOWER(display_name) LIKE ?)
         ORDER BY LOWER(username) = ? DESC, LOWER(username) LIMIT 25`,
        [req.user.id, `%${q}%`, `%${q}%`, q],
      );
      const results = [];
      for (const row of rows) {
        const link = await get(
          'SELECT * FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)',
          [req.user.id, row.id, row.id, req.user.id],
        );
        results.push({
          ...publicUser(row, req.user),
          online: isOnline(row.id),
          relation: link ? link.status : null,
          requestDirection: link ? (link.requester_id === req.user.id ? 'outgoing' : 'incoming') : null,
          friendshipId: link?.id || null,
        });
      }
      res.json({ users: results });
    }),
  );

  router.get(
    '/users/:id',
    asyncRoute(async (req, res) => {
      const row = await get('SELECT * FROM users WHERE id = ? AND is_banned = 0', [req.params.id]);
      assert(row, 404, 'User not found', 'not_found');
      const shared = await get(
        `SELECT 1 AS ok FROM conversation_members a JOIN conversation_members b ON a.conversation_id = b.conversation_id
          WHERE a.user_id = ? AND b.user_id = ? LIMIT 1`,
        [req.user.id, row.id],
      );
      const payload = publicUser(row, req.user);
      if (!shared && row.id !== req.user.id) payload.phone = null;
      const published = await all(
        "SELECT id, name, tagline, avatar_url FROM ai_personas WHERE owner_id = ? AND is_published = 1 AND is_blocked = 0 LIMIT 20",
        [row.id],
      );
      res.json({
        user: { ...payload, online: isOnline(row.id) },
        personas: published.map((p) => ({ id: p.id, name: p.name, tagline: p.tagline, avatarUrl: p.avatar_url })),
      });
    }),
  );

  /* ----------------------------------------------------------- friends */

  router.get(
    '/friends',
    asyncRoute(async (req, res) => {
      const rows = await all(
        `SELECT u.* FROM friendships f
           JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
          WHERE f.status = 'accepted' AND (f.requester_id = ? OR f.addressee_id = ?) AND u.is_banned = 0`,
        [req.user.id, req.user.id, req.user.id],
      );
      res.json({ friends: rows.map((r) => ({ ...publicUser(r, req.user), online: isOnline(r.id) })) });
    }),
  );

  router.get(
    '/friends/requests',
    asyncRoute(async (req, res) => {
      const incoming = await all(
        `SELECT f.id AS friendship_id, f.created_at, u.* FROM friendships f JOIN users u ON u.id = f.requester_id
          WHERE f.addressee_id = ? AND f.status = 'pending' AND u.is_banned = 0 ORDER BY f.created_at DESC`,
        [req.user.id],
      );
      const outgoing = await all(
        `SELECT f.id AS friendship_id, f.created_at, u.* FROM friendships f JOIN users u ON u.id = f.addressee_id
          WHERE f.requester_id = ? AND f.status = 'pending' AND u.is_banned = 0 ORDER BY f.created_at DESC`,
        [req.user.id],
      );
      res.json({
        incoming: incoming.map((r) => ({ friendshipId: r.friendship_id, createdAt: r.created_at, user: publicUser(r, req.user) })),
        outgoing: outgoing.map((r) => ({ friendshipId: r.friendship_id, createdAt: r.created_at, user: publicUser(r, req.user) })),
      });
    }),
  );

  router.post(
    '/friends/request',
    rateLimit({ windowMs: 60_000, max: 20, scope: 'friend-request' }),
    asyncRoute(async (req, res) => {
      let target = null;
      if (req.body?.userId) target = await get('SELECT * FROM users WHERE id = ? AND is_banned = 0', [String(req.body.userId)]);
      else if (req.body?.username) target = await get('SELECT * FROM users WHERE username = ? AND is_banned = 0', [String(req.body.username).toLowerCase()]);
      assert(target, 404, 'User not found', 'not_found');
      await assertNotBlocked(req.user.id, target.id);
      const privacy = parseJson(target.privacy, {}) || {};
      assert(privacy.allowFriendRequests !== false, 403, 'This user is not accepting friend requests', 'requests_disabled');
      const existing = await get(
        'SELECT * FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)',
        [req.user.id, target.id, target.id, req.user.id],
      );
      if (existing) {
        if (existing.status === 'accepted') return res.json({ ok: true, status: 'accepted', friendshipId: existing.id });
        if (existing.requester_id === req.user.id) return res.json({ ok: true, status: 'pending', friendshipId: existing.id });
        await run('UPDATE friendships SET status = ?, updated_at = ? WHERE id = ?', ['accepted', nowIso(), existing.id]);
        await notifyUser(existing.requester_id, 'friend_accepted', { userId: req.user.id, username: req.user.username });
        return res.json({ ok: true, status: 'accepted', friendshipId: existing.id });
      }
      const id = uid('frd_');
      const now = nowIso();
      await run('INSERT INTO friendships (id, requester_id, addressee_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, req.user.id, target.id, 'pending', now, now]);
      await notifyUser(target.id, 'friend_request', { userId: req.user.id, username: req.user.username, displayName: req.user.display_name });
      return res.json({ ok: true, status: 'pending', friendshipId: id });
    }),
  );

  router.post(
    '/friends/:id/accept',
    asyncRoute(async (req, res) => {
      const row = await get('SELECT * FROM friendships WHERE id = ? AND addressee_id = ? AND status = ?', [req.params.id, req.user.id, 'pending']);
      assert(row, 404, 'Request not found', 'not_found');
      await run('UPDATE friendships SET status = ?, updated_at = ? WHERE id = ?', ['accepted', nowIso(), row.id]);
      await notifyUser(row.requester_id, 'friend_accepted', { userId: req.user.id, username: req.user.username });
      res.json({ ok: true, status: 'accepted' });
    }),
  );

  router.post(
    '/friends/:id/decline',
    asyncRoute(async (req, res) => {
      const row = await get('SELECT * FROM friendships WHERE id = ? AND addressee_id = ?', [req.params.id, req.user.id]);
      assert(row, 404, 'Request not found', 'not_found');
      await run('DELETE FROM friendships WHERE id = ?', [row.id]);
      res.json({ ok: true });
    }),
  );

  router.delete(
    '/friends/:userId',
    asyncRoute(async (req, res) => {
      await run('DELETE FROM friendships WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)', [
        req.user.id, req.params.userId, req.params.userId, req.user.id,
      ]);
      res.json({ ok: true });
    }),
  );

  router.post(
    '/users/:id/block',
    asyncRoute(async (req, res) => {
      await assertNotBlocked(req.user.id, req.params.id);
      await run('INSERT INTO blocks (id, blocker_id, blocked_id, created_at) VALUES (?, ?, ?, ?)', [uid('blk_'), req.user.id, req.params.id, nowIso()]);
      res.json({ ok: true });
    }),
  );

  router.delete(
    '/users/:id/block',
    asyncRoute(async (req, res) => {
      await run('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?', [req.user.id, req.params.id]);
      res.json({ ok: true });
    }),
  );

  router.get(
    '/blocks',
    asyncRoute(async (req, res) => {
      const rows = await all('SELECT u.* FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ?', [req.user.id]);
      res.json({ blocked: rows.map((r) => publicUser(r, req.user)) });
    }),
  );

  /* ----------------------------------------------------- conversations */

  router.get(
    '/conversations',
    asyncRoute(async (req, res) => {
      const includeArchived = req.query.archived === '1';
      const rows = await all(
        `SELECT c.*, m.archived FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id AND m.user_id = ?
          ORDER BY c.updated_at DESC LIMIT 200`,
        [req.user.id],
      );
      const list = [];
      for (const row of rows) {
        const archived = bool(row.archived);
        if (archived !== includeArchived) continue;
        list.push(await conversationSummary(row, req.user.id));
      }
      res.json({ conversations: list });
    }),
  );

  router.post(
    '/conversations',
    asyncRoute(async (req, res) => {
      const targetId = String(req.body?.userId || '');
      assert(isValidId(targetId), 400, 'Choose someone to message', 'invalid_target');
      const target = await get('SELECT * FROM users WHERE id = ? AND is_banned = 0', [targetId]);
      assert(target, 404, 'User not found', 'not_found');
      await assertNotBlocked(req.user.id, targetId);
      const id = await findOrCreateDm(req.user.id, targetId);
      const conv = await get('SELECT * FROM conversations WHERE id = ?', [id]);
      const summary = await conversationSummary(conv, req.user.id);
      const otherSummary = await conversationSummary(conv, targetId);
      sendToUser(targetId, { type: 'conversation', conversation: otherSummary });
      res.json({ ok: true, conversation: summary });
    }),
  );

  router.post(
    '/conversations/group',
    asyncRoute(async (req, res) => {
      const title = str(req.body?.title, { min: 2, max: 60, field: 'group name' });
      const memberIds = Array.isArray(req.body?.memberIds) ? [...new Set(req.body.memberIds.map(String))].filter((id) => id !== req.user.id) : [];
      assert(memberIds.length >= 1, 400, 'Add at least one friend', 'invalid_members');
      assert(memberIds.length <= 100, 400, 'Groups are limited to 100 members', 'too_many_members');
      for (const id of memberIds) {
        const user = await get('SELECT id FROM users WHERE id = ? AND is_banned = 0', [id]);
        assert(user, 404, 'One of the selected people no longer exists', 'not_found');
        await assertNotBlocked(req.user.id, id);
      }
      const id = uid('cnv_');
      const now = nowIso();
      await run('INSERT INTO conversations (id, type, title, avatar_url, created_by, ai_persona_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, 'group', title, null, req.user.id, null, now, now]);
      await run('INSERT INTO conversation_members (conversation_id, user_id, role, mode, last_read_at, archived, muted, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, req.user.id, 'admin', 'manual', now, 0, 0, now]);
      for (const memberId of memberIds) {
        await run('INSERT INTO conversation_members (conversation_id, user_id, role, mode, last_read_at, archived, muted, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, memberId, 'member', 'manual', null, 0, 0, now]);
        await notifyUser(memberId, 'group_added', { conversationId: id, title });
      }
      await insertMessage({ conversationId: id, senderId: null, senderKind: 'system', kind: 'system', body: `${req.user.display_name} created the group "${title}"` });
      const conv = await get('SELECT * FROM conversations WHERE id = ?', [id]);
      for (const memberId of [req.user.id, ...memberIds]) {
        const summary = await conversationSummary(conv, memberId);
        sendToUser(memberId, { type: 'conversation', conversation: summary });
      }
      res.json({ ok: true, conversation: await conversationSummary(conv, req.user.id) });
    }),
  );

  router.get(
    '/conversations/:id',
    asyncRoute(async (req, res) => {
      await requireMember(req.params.id, req.user.id);
      const conv = await get('SELECT * FROM conversations WHERE id = ?', [req.params.id]);
      assert(conv, 404, 'Conversation not found', 'not_found');
      res.json({ conversation: await conversationSummary(conv, req.user.id) });
    }),
  );

  router.patch(
    '/conversations/:id',
    asyncRoute(async (req, res) => {
      const member = await requireMember(req.params.id, req.user.id);
      const conv = await get('SELECT * FROM conversations WHERE id = ?', [req.params.id]);
      const updates = [];
      const params = [];
      if (typeof req.body?.title === 'string' && conv.type === 'group') {
        updates.push('title = ?');
        params.push(str(req.body.title, { min: 2, max: 60, field: 'group name' }));
      }
      if (updates.length) {
        params.push(req.params.id);
        await run(`UPDATE conversations SET ${updates.join(', ')} WHERE id = ?`, params);
      }
      if (typeof req.body?.archived === 'boolean') {
        await run('UPDATE conversation_members SET archived = ? WHERE conversation_id = ? AND user_id = ?', [req.body.archived ? 1 : 0, req.params.id, req.user.id]);
      }
      if (typeof req.body?.muted === 'boolean') {
        await run('UPDATE conversation_members SET muted = ? WHERE conversation_id = ? AND user_id = ?', [req.body.muted ? 1 : 0, req.params.id, req.user.id]);
      }
      if (typeof req.body?.mode === 'string' && ['manual', 'ai', 'hybrid'].includes(req.body.mode)) {
        const personaId = req.body.personaId ? String(req.body.personaId) : null;
        if (req.body.mode !== 'manual') {
          assert(personaId, 400, 'Choose which AI personality may speak for you', 'persona_required');
          const persona = await get('SELECT * FROM ai_personas WHERE id = ? AND owner_id = ?', [personaId, req.user.id]);
          assert(persona, 404, 'Personality not found', 'not_found');
        }
        await run('UPDATE conversation_members SET mode = ?, ai_persona_id = ? WHERE conversation_id = ? AND user_id = ?', [
          req.body.mode, req.body.mode === 'manual' ? null : personaId, req.params.id, req.user.id,
        ]);
        await insertMessage({
          conversationId: req.params.id,
          senderId: null,
          senderKind: 'system',
          kind: 'system',
          body:
            req.body.mode === 'manual'
              ? `${req.user.display_name} turned AI assistance off`
              : `${req.user.display_name} enabled ${req.body.mode === 'hybrid' ? 'AI suggestions (hybrid)' : 'AI auto-reply'}`,
        });
      }
      const fresh = await get('SELECT * FROM conversations WHERE id = ?', [req.params.id]);
      const summary = await conversationSummary(fresh, req.user.id);
      const ids = await conversationMemberIds(req.params.id);
      sendToUsers(ids, { type: 'conversation', conversation: summary }, req.user.id);
      res.json({ ok: true, conversation: summary, member });
    }),
  );

  router.post(
    '/conversations/:id/members',
    asyncRoute(async (req, res) => {
      const member = await requireMember(req.params.id, req.user.id);
      const conv = await get('SELECT * FROM conversations WHERE id = ?', [req.params.id]);
      assert(conv.type === 'group', 400, 'Only groups can gain members', 'invalid_type');
      assert(member.role === 'admin', 403, 'Only group admins can add members', 'forbidden');
      const userId = String(req.body?.userId || '');
      const user = await get('SELECT * FROM users WHERE id = ? AND is_banned = 0', [userId]);
      assert(user, 404, 'User not found', 'not_found');
      const existing = await memberOf(req.params.id, userId);
      if (existing) return res.json({ ok: true, alreadyMember: true });
      await run('INSERT INTO conversation_members (conversation_id, user_id, role, mode, last_read_at, archived, muted, joined_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [req.params.id, userId, 'member', 'manual', null, 0, 0, nowIso()]);
      await insertMessage({ conversationId: req.params.id, senderId: null, senderKind: 'system', kind: 'system', body: `${user.display_name} joined the group` });
      await notifyUser(userId, 'group_added', { conversationId: req.params.id, title: conv.title });
      const summary = await conversationSummary(conv, userId);
      sendToUser(userId, { type: 'conversation', conversation: summary });
      res.json({ ok: true });
    }),
  );

  router.delete(
    '/conversations/:id/members/:userId',
    asyncRoute(async (req, res) => {
      const member = await requireMember(req.params.id, req.user.id);
      const targetId = req.params.userId;
      if (targetId !== req.user.id) assert(member.role === 'admin', 403, 'Only group admins can remove members', 'forbidden');
      await run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [req.params.id, targetId]);
      await insertMessage({
        conversationId: req.params.id,
        senderId: null,
        senderKind: 'system',
        kind: 'system',
        body: targetId === req.user.id ? `${req.user.display_name} left the group` : `${req.user.display_name} removed a member`,
      });
      res.json({ ok: true });
    }),
  );

  /* ---------------------------------------------------------- messages */

  router.get(
    '/conversations/:id/messages',
    asyncRoute(async (req, res) => {
      await requireMember(req.params.id, req.user.id);
      const limit = Math.min(Math.max(Number(req.query.limit) || 40, 1), 100);
      const before = req.query.before ? String(req.query.before) : null;
      const rows = before
        ? await all('SELECT * FROM messages WHERE conversation_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?', [req.params.id, before, limit])
        : await all('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?', [req.params.id, limit]);
      const messages = [];
      for (const row of rows.reverse()) messages.push(await serializeMessage(row, req.user.id));
      res.json({ messages, hasMore: rows.length === limit });
    }),
  );

  router.post(
    '/conversations/:id/messages',
    rateLimit({ windowMs: 60_000, max: 120, scope: 'send-message' }),
    asyncRoute(async (req, res) => {
      const member = await requireMember(req.params.id, req.user.id);
      const conv = await get('SELECT * FROM conversations WHERE id = ?', [req.params.id]);
      assert(conv, 404, 'Conversation not found', 'not_found');
      const kind = ['text', 'image', 'video', 'audio', 'file'].includes(req.body?.kind) ? req.body.kind : 'text';
      const body = typeof req.body?.body === 'string' ? str(req.body.body, { max: 4000, field: 'message' }) : '';
      const mediaId = req.body?.mediaId ? String(req.body.mediaId) : null;
      assert(body.length > 0 || mediaId, 400, 'Write a message or attach a file', 'empty_message');
      if (mediaId) {
        const media = await get('SELECT id FROM media WHERE id = ? AND owner_id = ?', [mediaId, req.user.id]);
        assert(media, 400, 'Attachment not found', 'media_missing');
      }
      if (conv.type === 'dm') {
        const ids = await conversationMemberIds(req.params.id);
        const other = ids.find((id) => id !== req.user.id);
        if (other) await assertNotBlocked(req.user.id, other);
      }
      const row = await insertMessage({
        conversationId: req.params.id,
        senderId: req.user.id,
        senderKind: 'user',
        kind: mediaId && kind === 'text' ? 'text' : kind,
        body,
        mediaId,
        replyTo: req.body?.replyTo ? String(req.body.replyTo) : null,
      });
      await run('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?', [nowIso(), req.params.id, req.user.id]);
      const message = await serializeMessage(row, req.user.id);
      const ids = await broadcastMessage(req.params.id, message, req.user.id);
      for (const id of ids) {
        if (id === req.user.id) continue;
        const m = await memberOf(req.params.id, id);
        if (m && bool(m.muted)) continue;
        const conv2 = await get('SELECT * FROM conversations WHERE id = ?', [req.params.id]);
        sendToUser(id, {
          type: 'conversation',
          conversation: await conversationSummary(conv2, id),
        });
      }
      res.json({ ok: true, message });

      // Autonomous AI participation (AI / hybrid modes) — never impersonates silently.
      const senderMember = member;
      if (senderMember && senderMember.mode && senderMember.mode !== 'manual' && conv.type !== 'ai') {
        try {
          const { runAutonomousReply } = await import('./ai.js');
          await runAutonomousReply({ conversationId: req.params.id, actorMember: senderMember, triggerMessage: row });
        } catch (err) {
          console.error('[ai] autonomous reply failed', err.message);
        }
      }
    }),
  );

  router.patch(
    '/messages/:id',
    asyncRoute(async (req, res) => {
      const row = await get('SELECT * FROM messages WHERE id = ?', [req.params.id]);
      assert(row, 404, 'Message not found', 'not_found');
      await requireMember(row.conversation_id, req.user.id);
      assert(row.sender_id === req.user.id, 403, 'You can only edit your own messages', 'forbidden');
      assert(!row.deleted_at, 400, 'This message was deleted', 'deleted');
      const body = str(req.body?.body, { min: 1, max: 4000, field: 'message' });
      const editedAt = nowIso();
      await run('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?', [body, editedAt, row.id]);
      const fresh = await get('SELECT * FROM messages WHERE id = ?', [row.id]);
      const message = await serializeMessage(fresh, req.user.id);
      const ids = await conversationMemberIds(row.conversation_id);
      sendToUsers(ids, { type: 'message_update', message });
      res.json({ ok: true, message });
    }),
  );

  router.delete(
    '/messages/:id',
    asyncRoute(async (req, res) => {
      const row = await get('SELECT * FROM messages WHERE id = ?', [req.params.id]);
      assert(row, 404, 'Message not found', 'not_found');
      const member = await requireMember(row.conversation_id, req.user.id);
      assert(row.sender_id === req.user.id || member.role === 'admin', 403, 'You cannot delete this message', 'forbidden');
      const deletedAt = nowIso();
      await run('UPDATE messages SET deleted_at = ?, body = NULL, media_id = NULL WHERE id = ?', [deletedAt, row.id]);
      const ids = await conversationMemberIds(row.conversation_id);
      sendToUsers(ids, { type: 'message_delete', messageId: row.id, conversationId: row.conversation_id, deletedAt });
      res.json({ ok: true });
    }),
  );

  router.post(
    '/messages/:id/reactions',
    asyncRoute(async (req, res) => {
      const row = await get('SELECT * FROM messages WHERE id = ?', [req.params.id]);
      assert(row, 404, 'Message not found', 'not_found');
      await requireMember(row.conversation_id, req.user.id);
      const emoji = str(req.body?.emoji, { min: 1, max: 8, field: 'reaction' });
      await run(
        'INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = ?, created_at = ?',
        [row.id, req.user.id, emoji, nowIso(), emoji, nowIso()],
      );
      const fresh = await get('SELECT * FROM messages WHERE id = ?', [row.id]);
      const message = await serializeMessage(fresh, req.user.id);
      const ids = await conversationMemberIds(row.conversation_id);
      sendToUsers(ids, { type: 'message_update', message });
      res.json({ ok: true, message });
    }),
  );

  router.delete(
    '/messages/:id/reactions',
    asyncRoute(async (req, res) => {
      const row = await get('SELECT * FROM messages WHERE id = ?', [req.params.id]);
      assert(row, 404, 'Message not found', 'not_found');
      await requireMember(row.conversation_id, req.user.id);
      await run('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?', [row.id, req.user.id]);
      const fresh = await get('SELECT * FROM messages WHERE id = ?', [row.id]);
      const message = await serializeMessage(fresh, req.user.id);
      const ids = await conversationMemberIds(row.conversation_id);
      sendToUsers(ids, { type: 'message_update', message });
      res.json({ ok: true, message });
    }),
  );

  router.get(
    '/messages/search',
    asyncRoute(async (req, res) => {
      const q = String(req.query.q || '').trim();
      assert(q.length >= 2, 400, 'Type at least 2 characters', 'invalid_query');
      const rows = await all(
        `SELECT m.* FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
          WHERE m.deleted_at IS NULL AND LOWER(m.body) LIKE ? ORDER BY m.created_at DESC LIMIT 40`,
        [req.user.id, `%${q.toLowerCase()}%`],
      );
      const results = [];
      for (const row of rows) {
        const conv = await get('SELECT id, type, title FROM conversations WHERE id = ?', [row.conversation_id]);
        results.push({ message: await serializeMessage(row, req.user.id), conversation: conv ? { id: conv.id, type: conv.type, title: conv.title } : null });
      }
      res.json({ results });
    }),
  );

  /* ------------------------------------------------------------- media */

  router.post(
    '/media',
    express.raw({ type: () => true, limit: MAX_MEDIA_BYTES }),
    asyncRoute(async (req, res) => {
      const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0];
      const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      assert(buffer.length > 0, 400, 'Empty upload', 'empty_upload');
      assert(buffer.length <= MAX_MEDIA_BYTES, 413, 'Files must be 10 MB or smaller', 'too_large');
      const allowed = /^(image|video|audio)\//.test(mime) || ['application/pdf', 'text/plain', 'application/zip', 'application/octet-stream'].includes(mime);
      assert(allowed, 415, 'Unsupported file type', 'unsupported_type');
      const id = uid('med_');
      await run('INSERT INTO media (id, owner_id, mime, size, filename, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        id, req.user.id, mime, buffer.length, String(req.headers['x-filename'] || 'upload').slice(0, 120), buffer.toString('base64'), nowIso(),
      ]);
      res.json({ ok: true, media: { id, url: `/api/media/${id}`, mime, size: buffer.length } });
    }),
  );

  return router;
}

/** Media is served separately so <img>/<video> tags can authenticate with ?token=. */
export function mediaRoutes() {
  const router = express.Router();
  router.get(
    '/:id',
    asyncRoute(async (req, res) => {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : String(req.query.token || '');
      if (!token) return res.status(401).json({ error: 'Sign in required', code: 'unauthorized' });
      const session = await get('SELECT user_id FROM sessions WHERE token_hash = ?', [sha256Token(token)]);
      if (!session) return res.status(401).json({ error: 'Sign in required', code: 'unauthorized' });
      const row = await get('SELECT * FROM media WHERE id = ?', [req.params.id]);
      if (!row) return res.status(404).json({ error: 'Not found', code: 'not_found' });
      const buf = Buffer.from(row.data, 'base64');
      res.setHeader('Content-Type', row.mime);
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('Cache-Control', 'private, max-age=86400');
      return res.send(buf);
    }),
  );
  return router;
}

// Local import to avoid a cycle with util through auth.
function sha256Token(token) {
  // eslint-disable-next-line global-require
  return sha256Hex(token);
}

let sha256Hex = () => '';
export function bindMediaHasher(fn) {
  sha256Hex = fn;
}
