import { getSupabasePublicConfig } from './lib/supabase.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }
  try {
    const config = getSupabasePublicConfig();
    res.status(200).json({ ok: true, supabaseUrl: config.url, supabaseAnonKey: config.anonKey });
  } catch (error) {
    res.status(500).json({ ok: false, error: 'SUPABASE_PUBLIC_ENV_MISSING' });
  }
}
