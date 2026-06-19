import crypto from 'node:crypto';
import { getSupabaseAdmin } from './supabase.js';

const COOKIE_NAME = 'bh_session';
const SESSION_TTL_DAYS = 180;

function parseCookies(header) {
  return Object.fromEntries(
    String(header || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf('=');
        return idx >= 0 ? [part.slice(0, idx), decodeURIComponent(part.slice(idx + 1))] : [part, ''];
      })
  );
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function hashPasscode(passcode) {
  return crypto.scryptSync(String(passcode), 'book-highlighter-passcode', 64).toString('hex');
}

export function verifyPasscode(passcode, hash) {
  return crypto.timingSafeEqual(Buffer.from(hashPasscode(passcode)), Buffer.from(String(hash || '')));
}

export function getSessionCookieValue(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return String(cookies[COOKIE_NAME] || '').trim();
}

export function setSessionCookie(res, token) {
  const maxAge = SESSION_TTL_DAYS * 24 * 60 * 60;
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}; Secure`);
}

export function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`);
}

export async function createSession(userId) {
  const admin = getSupabaseAdmin();
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await admin.from('app_sessions').insert({ user_id: userId, token_hash: tokenHash, expires_at: expiresAt });
  if (error) throw error;
  return token;
}

export async function destroySessionByToken(token) {
  if (!token) return;
  const admin = getSupabaseAdmin();
  await admin.from('app_sessions').delete().eq('token_hash', sha256(token));
}

export async function requireSessionUser(req) {
  const token = getSessionCookieValue(req);
  if (!token) throw new Error('AUTH_REQUIRED');
  const admin = getSupabaseAdmin();
  const { data: session, error } = await admin
    .from('app_sessions')
    .select('id, user_id, expires_at, app_users(*)')
    .eq('token_hash', sha256(token))
    .maybeSingle();
  if (error || !session) throw new Error('AUTH_REQUIRED');
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await destroySessionByToken(token);
    throw new Error('SESSION_EXPIRED');
  }
  return { session, user: session.app_users };
}
