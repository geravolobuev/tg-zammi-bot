import { deleteBook, getCurrentBook, listBooks, setCurrentBook } from './lib/book-store.js';

function getUserId(req) {
  const fromHeader = String(req.headers['x-user-id'] || '').trim();
  const fromQuery = String(req.query?.userId || '').trim();
  const fromBody = String(req.body?.userId || '').trim();
  const userId = fromHeader || fromQuery || fromBody;
  if (!userId) throw new Error('USER_ID_REQUIRED');
  return userId;
}

function getTitle(req) {
  return String(req.body?.title || req.query?.title || '').replace(/\s+/g, ' ').trim();
}

export default async function handler(req, res) {
  try {
    const userId = getUserId(req);

    if (req.method === 'GET') {
      const [books, currentBook] = await Promise.all([listBooks(userId), getCurrentBook(userId)]);
      res.status(200).json({ ok: true, books, currentBook });
      return;
    }

    if (req.method === 'POST') {
      const title = getTitle(req);
      if (!title) {
        res.status(400).json({ ok: false, error: 'TITLE_REQUIRED' });
        return;
      }
      const currentBook = await setCurrentBook(userId, title);
      const books = await listBooks(userId);
      res.status(200).json({ ok: true, currentBook, books });
      return;
    }

    if (req.method === 'DELETE') {
      const title = getTitle(req);
      if (!title) {
        res.status(400).json({ ok: false, error: 'TITLE_REQUIRED' });
        return;
      }
      const result = await deleteBook(userId, title);
      const books = await listBooks(userId);
      const currentBook = await getCurrentBook(userId);
      res.status(200).json({ ok: true, result, books, currentBook });
      return;
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (error) {
    const message = String(error?.message || 'BOOKS_ERROR');
    if (message.includes('USER_ID_REQUIRED')) {
      res.status(400).json({ ok: false, error: 'USER_ID_REQUIRED' });
      return;
    }
    console.error(error);
    res.status(500).json({ ok: false, error: 'BOOKS_ERROR' });
  }
}
