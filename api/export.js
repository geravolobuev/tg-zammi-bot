import { getAllBookNotes } from './lib/book-store.js';

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

function toSafeFileName(title) {
  const safe = String(title || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  return (safe || 'book').slice(0, 80);
}

function formatTs(ts) {
  const dt = new Date(Number(ts || 0));
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function buildMarkdown(bookTitle, notes) {
  const now = new Date().toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
  const lines = [
    `# ${bookTitle}`,
    '',
    `Экспорт: ${now} (Europe/Moscow)`,
    `Количество заметок: ${notes.length}`,
    ''
  ];
  notes.forEach((note, index) => {
    lines.push(`## ${index + 1}${note.ts ? ` (${formatTs(note.ts)})` : ''}`);
    lines.push(note.text);
    lines.push('');
  });
  return `${lines.join('\n').trim()}\n`;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') {
      res.status(405).json({ ok: false, error: 'Method not allowed' });
      return;
    }
    const userId = getUserId(req);
    const bookTitle = normalizeTitle(req.query?.title || '');
    const result = await getAllBookNotes(userId, bookTitle || null);
    if (result.notes.length === 0) {
      res.status(200).json({ ok: false, error: 'NO_NOTES' });
      return;
    }
    const markdown = buildMarkdown(result.book.title, result.notes);
    const filename = `${toSafeFileName(result.book.title)}.md`;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.status(200).send(markdown);
  } catch (error) {
    const message = String(error?.message || 'EXPORT_ERROR');
    if (message.includes('USER_ID_REQUIRED')) {
      res.status(400).json({ ok: false, error: 'USER_ID_REQUIRED' });
      return;
    }
    if (message.includes('BOOK_NOT_SELECTED')) {
      res.status(200).json({ ok: false, error: 'BOOK_NOT_SELECTED' });
      return;
    }
    console.error(error);
    res.status(500).json({ ok: false, error: 'EXPORT_ERROR' });
  }
}
