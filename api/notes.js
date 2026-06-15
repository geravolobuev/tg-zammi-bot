import { addBookNote, getBookNotes } from './lib/book-store.js';

function getUserId(req) {
  const fromHeader = String(req.headers['x-user-id'] || '').trim();
  const fromQuery = String(req.query?.userId || '').trim();
  const fromBody = String(req.body?.userId || '').trim();
  const userId = fromHeader || fromQuery || fromBody;
  if (!userId) throw new Error('USER_ID_REQUIRED');
  return userId;
}

function normalizeTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export default async function handler(req, res) {
  try {
    const userId = getUserId(req);

    if (req.method === 'GET') {
      const bookTitle = normalizeTitle(req.query?.title || '');
      const result = await getBookNotes(userId, bookTitle || null, 5);
      res.status(200).json({ ok: true, ...result });
      return;
    }

    if (req.method === 'POST') {
      const text = normalizeTitle(req.body?.text || '');
      const bookTitle = normalizeTitle(req.body?.bookTitle || '');
      if (!text) {
        res.status(400).json({ ok: false, error: 'TEXT_REQUIRED' });
        return;
      }
      const book = await addBookNote(userId, text, { bookTitle: bookTitle || undefined });
      const result = await getBookNotes(userId, book.title, 5);
      res.status(200).json({ ok: true, book, notes: result.notes });
      return;
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (error) {
    const message = String(error?.message || 'NOTES_ERROR');
    if (message.includes('USER_ID_REQUIRED')) {
      res.status(400).json({ ok: false, error: 'USER_ID_REQUIRED' });
      return;
    }
    if (message.includes('BOOK_NOT_SELECTED')) {
      res.status(200).json({ ok: false, error: 'BOOK_NOT_SELECTED' });
      return;
    }
    console.error(error);
    res.status(500).json({ ok: false, error: 'NOTES_ERROR' });
  }
}
