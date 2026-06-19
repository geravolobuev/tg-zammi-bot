import { requireSessionUser } from './lib/auth.js';
import { getSupabaseAdmin } from './lib/supabase.js';

function normalizeTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function formatBook(book) {
  return book ? { id: book.id, title: book.title, created_at: book.created_at, updated_at: book.updated_at } : null;
}

export default async function handler(req, res) {
  const admin = getSupabaseAdmin();
  let user;
  try {
    ({ user } = await requireSessionUser(req));
  } catch (error) {
    res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    return;
  }

  try {
    if (req.method === 'GET') {
      const { data: profile, error: profileError } = await admin.from('profiles').select('*').eq('id', user.id).maybeSingle();
      if (profileError) throw profileError;
      const { data: books, error: booksError } = await admin.from('books').select('*').eq('user_id', user.id).order('title', { ascending: true });
      if (booksError) throw booksError;
      const currentBook = (books || []).find((book) => book.id === profile?.current_book_id) || null;
      const bookId = String(req.query?.bookId || currentBook?.id || '').trim();
      let notes = [];
      if (bookId) {
        const { data: loadedNotes, error: notesError } = await admin.from('notes').select('id, text, created_at').eq('user_id', user.id).eq('book_id', bookId).order('created_at', { ascending: false }).limit(5);
        if (notesError) throw notesError;
        notes = loadedNotes || [];
      }
      res.status(200).json({ ok: true, user: { id: user.id, username: user.username }, books: (books || []).map(formatBook), currentBook: formatBook(currentBook), notes });
      return;
    }

    if (req.method === 'POST') {
      const action = String(req.body?.action || '').trim();

      if (action === 'book_upsert') {
        const title = normalizeTitle(req.body?.title);
        if (!title) {
          res.status(400).json({ ok: false, error: 'TITLE_REQUIRED' });
          return;
        }
        let { data: book, error: bookError } = await admin.from('books').select('*').eq('user_id', user.id).ilike('title', title).maybeSingle();
        if (bookError) throw bookError;
        if (!book) {
          const created = await admin.from('books').insert({ user_id: user.id, title }).select('*').single();
          if (created.error) throw created.error;
          book = created.data;
        }
        const { error: profileError } = await admin.from('profiles').update({ current_book_id: book.id }).eq('id', user.id);
        if (profileError) throw profileError;
        res.status(200).json({ ok: true, currentBook: formatBook(book) });
        return;
      }

      if (action === 'book_select') {
        const bookId = String(req.body?.bookId || '').trim();
        if (!bookId) {
          res.status(400).json({ ok: false, error: 'BOOK_ID_REQUIRED' });
          return;
        }
        const { data: book, error: bookError } = await admin.from('books').select('*').eq('id', bookId).eq('user_id', user.id).maybeSingle();
        if (bookError) throw bookError;
        if (!book) {
          res.status(404).json({ ok: false, error: 'BOOK_NOT_FOUND' });
          return;
        }
        const { error: profileError } = await admin.from('profiles').update({ current_book_id: book.id }).eq('id', user.id);
        if (profileError) throw profileError;
        res.status(200).json({ ok: true, currentBook: formatBook(book) });
        return;
      }

      if (action === 'note_create') {
        const text = String(req.body?.text || '').trim();
        const bookId = String(req.body?.bookId || '').trim();
        if (!bookId) {
          res.status(400).json({ ok: false, error: 'BOOK_ID_REQUIRED' });
          return;
        }
        if (!text) {
          res.status(400).json({ ok: false, error: 'TEXT_REQUIRED' });
          return;
        }
        const { data: book, error: bookError } = await admin.from('books').select('*').eq('id', bookId).eq('user_id', user.id).maybeSingle();
        if (bookError) throw bookError;
        if (!book) {
          res.status(404).json({ ok: false, error: 'BOOK_NOT_FOUND' });
          return;
        }
        const { error: noteError } = await admin.from('notes').insert({ user_id: user.id, book_id: bookId, text });
        if (noteError) throw noteError;
        const { data: notes, error: notesError } = await admin.from('notes').select('id, text, created_at').eq('user_id', user.id).eq('book_id', bookId).order('created_at', { ascending: false }).limit(5);
        if (notesError) throw notesError;
        res.status(200).json({ ok: true, currentBook: formatBook(book), notes: notes || [] });
        return;
      }

      res.status(400).json({ ok: false, error: 'UNKNOWN_ACTION' });
      return;
    }

    if (req.method === 'DELETE') {
      const action = String(req.query?.action || '').trim();
      if (action !== 'book_delete') {
        res.status(400).json({ ok: false, error: 'UNKNOWN_ACTION' });
        return;
      }
      const bookId = String(req.query?.bookId || '').trim();
      if (!bookId) {
        res.status(400).json({ ok: false, error: 'BOOK_ID_REQUIRED' });
        return;
      }
      const { data: profile } = await admin.from('profiles').select('*').eq('id', user.id).maybeSingle();
      const { error: deleteError } = await admin.from('books').delete().eq('id', bookId).eq('user_id', user.id);
      if (deleteError) throw deleteError;
      if (profile?.current_book_id === bookId) {
        const { error: profileError } = await admin.from('profiles').update({ current_book_id: null }).eq('id', user.id);
        if (profileError) throw profileError;
      }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: 'DATA_ERROR' });
  }
}
