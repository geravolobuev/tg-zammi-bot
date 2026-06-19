import { clearSessionCookie, createSession, destroySessionByToken, getSessionCookieValue, hashPasscode, requireSessionUser, setSessionCookie, verifyPasscode } from './lib/auth.js';
import { getSupabaseAdmin } from './lib/supabase.js';

function normalizeUsername(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export default async function handler(req, res) {
  const admin = getSupabaseAdmin();

  try {
    if (req.method === 'GET') {
      try {
        const { user } = await requireSessionUser(req);
        res.status(200).json({ ok: true, user: { id: user.id, username: user.username } });
      } catch {
        res.status(200).json({ ok: true, user: null });
      }
      return;
    }

    if (req.method === 'POST') {
      const username = normalizeUsername(req.body?.username);
      const passcode = String(req.body?.passcode || '').trim();
      if (!username || !passcode) {
        res.status(400).json({ ok: false, error: 'USERNAME_AND_PASSCODE_REQUIRED' });
        return;
      }

      const { data: existing, error: selectError } = await admin.from('app_users').select('*').eq('username', username).maybeSingle();
      if (selectError) throw selectError;

      let user = existing;
      if (!user) {
        const passcodeHash = hashPasscode(passcode);
        const { data: created, error: createError } = await admin.from('app_users').insert({ username, passcode_hash: passcodeHash }).select('*').single();
        if (createError) throw createError;
        user = created;
        const { error: profileError } = await admin.from('profiles').insert({ id: user.id });
        if (profileError) throw profileError;
      } else if (!verifyPasscode(passcode, user.passcode_hash)) {
        res.status(403).json({ ok: false, error: 'INVALID_CREDENTIALS' });
        return;
      }

      const token = await createSession(user.id);
      setSessionCookie(res, token);
      res.status(200).json({ ok: true, user: { id: user.id, username: user.username } });
      return;
    }

    if (req.method === 'DELETE') {
      await destroySessionByToken(getSessionCookieValue(req));
      clearSessionCookie(res);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: 'AUTH_ERROR' });
  }
}
