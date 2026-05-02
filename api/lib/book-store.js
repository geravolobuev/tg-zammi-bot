import crypto from "node:crypto";

const memory = {
  currentByUser: new Map(),
  booksByUser: new Map(),
  notesByUserAndSlug: new Map()
};

function redisConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return null;
  }
  return { url: url.replace(/\/+$/, ""), token };
}

function titleToSlug(title) {
  return crypto
    .createHash("sha1")
    .update(String(title || "").trim().toLowerCase())
    .digest("hex")
    .slice(0, 16);
}

function normalizeTitle(title) {
  return String(title || "").replace(/\s+/g, " ").trim();
}

function keyCurrentSlug(userId) {
  return `user:${userId}:book:current_slug`;
}

function keyCurrentTitle(userId) {
  return `user:${userId}:book:current_title`;
}

function keyBookSlugs(userId) {
  return `user:${userId}:book:slugs`;
}

function keyBookTitle(userId, slug) {
  return `user:${userId}:book:title:${slug}`;
}

function keyBookNotes(userId, slug) {
  return `user:${userId}:book:notes:${slug}`;
}

async function redisCommand(args) {
  const cfg = redisConfig();
  if (!cfg) {
    return null;
  }
  const path = args.map((x) => encodeURIComponent(String(x))).join("/");
  const response = await fetch(`${cfg.url}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`
    }
  });
  if (!response.ok) {
    throw new Error(`Upstash error: ${response.status}`);
  }
  const payload = await response.json();
  if (payload?.error) {
    throw new Error(`Upstash error: ${payload.error}`);
  }
  return payload?.result;
}

function memoryNotesKey(userId, slug) {
  return `${userId}:${slug}`;
}

export async function setCurrentBook(userId, rawTitle) {
  const title = normalizeTitle(rawTitle);
  if (!title) {
    throw new Error("EMPTY_BOOK_TITLE");
  }
  const slug = titleToSlug(title);

  if (redisConfig()) {
    await redisCommand(["SET", keyCurrentSlug(userId), slug]);
    await redisCommand(["SET", keyCurrentTitle(userId), title]);
    await redisCommand(["SADD", keyBookSlugs(userId), slug]);
    await redisCommand(["SET", keyBookTitle(userId, slug), title]);
    return { slug, title };
  }

  memory.currentByUser.set(String(userId), { slug, title });
  if (!memory.booksByUser.has(String(userId))) {
    memory.booksByUser.set(String(userId), new Map());
  }
  memory.booksByUser.get(String(userId)).set(slug, title);
  return { slug, title };
}

export async function getCurrentBook(userId) {
  if (redisConfig()) {
    const slug = await redisCommand(["GET", keyCurrentSlug(userId)]);
    if (!slug) {
      return null;
    }
    const title =
      (await redisCommand(["GET", keyCurrentTitle(userId)])) ||
      (await redisCommand(["GET", keyBookTitle(userId, slug)]));
    return title ? { slug, title } : null;
  }

  return memory.currentByUser.get(String(userId)) || null;
}

export async function listBooks(userId) {
  if (redisConfig()) {
    const slugs = (await redisCommand(["SMEMBERS", keyBookSlugs(userId)])) || [];
    const books = [];
    for (const slug of slugs) {
      const title = await redisCommand(["GET", keyBookTitle(userId, slug)]);
      if (title) {
        books.push({ slug, title });
      }
    }
    books.sort((a, b) => a.title.localeCompare(b.title, "ru"));
    return books;
  }

  const booksMap = memory.booksByUser.get(String(userId)) || new Map();
  return [...booksMap.entries()]
    .map(([slug, title]) => ({ slug, title }))
    .sort((a, b) => a.title.localeCompare(b.title, "ru"));
}

export async function addBookNote(userId, text, options = {}) {
  const cleanText = normalizeTitle(text);
  if (!cleanText) {
    throw new Error("EMPTY_NOTE_TEXT");
  }

  let book = null;
  if (options.bookTitle) {
    book = await setCurrentBook(userId, options.bookTitle);
  } else {
    book = await getCurrentBook(userId);
  }
  if (!book) {
    throw new Error("BOOK_NOT_SELECTED");
  }

  const note = JSON.stringify({
    text: cleanText,
    ts: Date.now()
  });

  if (redisConfig()) {
    const key = keyBookNotes(userId, book.slug);
    await redisCommand(["RPUSH", key, note]);
    await redisCommand(["LTRIM", key, -500, -1]);
  } else {
    const key = memoryNotesKey(userId, book.slug);
    if (!memory.notesByUserAndSlug.has(key)) {
      memory.notesByUserAndSlug.set(key, []);
    }
    const arr = memory.notesByUserAndSlug.get(key);
    arr.push(note);
    while (arr.length > 500) {
      arr.shift();
    }
  }

  return book;
}

function parseNote(raw) {
  try {
    const payload = JSON.parse(raw);
    return {
      text: normalizeTitle(payload?.text || ""),
      ts: Number(payload?.ts || 0)
    };
  } catch {
    return {
      text: normalizeTitle(raw),
      ts: 0
    };
  }
}

export async function getBookNotes(userId, rawTitleOrNull, limit = 10) {
  let book = null;
  if (rawTitleOrNull) {
    const title = normalizeTitle(rawTitleOrNull);
    if (!title) {
      throw new Error("BOOK_NOT_SELECTED");
    }
    const slug = titleToSlug(title);
    book = { slug, title };
  } else {
    book = await getCurrentBook(userId);
  }
  if (!book) {
    throw new Error("BOOK_NOT_SELECTED");
  }

  let rows = [];
  if (redisConfig()) {
    rows = (await redisCommand(["LRANGE", keyBookNotes(userId, book.slug), -limit, -1])) || [];
  } else {
    rows = (memory.notesByUserAndSlug.get(memoryNotesKey(userId, book.slug)) || []).slice(-limit);
  }

  const notes = rows.map(parseNote).filter((x) => x.text);
  return { book, notes };
}

export async function getAllBookNotes(userId, rawTitleOrNull) {
  let book = null;
  if (rawTitleOrNull) {
    const title = normalizeTitle(rawTitleOrNull);
    if (!title) {
      throw new Error("BOOK_NOT_SELECTED");
    }
    const slug = titleToSlug(title);
    book = { slug, title };
  } else {
    book = await getCurrentBook(userId);
  }
  if (!book) {
    throw new Error("BOOK_NOT_SELECTED");
  }

  let rows = [];
  if (redisConfig()) {
    rows = (await redisCommand(["LRANGE", keyBookNotes(userId, book.slug), 0, -1])) || [];
  } else {
    rows = memory.notesByUserAndSlug.get(memoryNotesKey(userId, book.slug)) || [];
  }

  const notes = rows.map(parseNote).filter((x) => x.text);
  return { book, notes };
}

export async function deleteBook(userId, rawTitle) {
  const title = normalizeTitle(rawTitle);
  if (!title) {
    throw new Error("EMPTY_BOOK_TITLE");
  }

  const slug = titleToSlug(title);

  if (redisConfig()) {
    const storedTitle = await redisCommand(["GET", keyBookTitle(userId, slug)]);
    if (!storedTitle) {
      return { deleted: false, title, clearedCurrent: false };
    }

    const currentSlug = await redisCommand(["GET", keyCurrentSlug(userId)]);
    const clearedCurrent = currentSlug === slug;

    await redisCommand(["DEL", keyBookNotes(userId, slug)]);
    await redisCommand(["DEL", keyBookTitle(userId, slug)]);
    await redisCommand(["SREM", keyBookSlugs(userId), slug]);

    if (clearedCurrent) {
      await redisCommand(["DEL", keyCurrentSlug(userId)]);
      await redisCommand(["DEL", keyCurrentTitle(userId)]);
    }

    return { deleted: true, title: storedTitle, clearedCurrent };
  }

  const userKey = String(userId);
  const booksMap = memory.booksByUser.get(userKey);
  if (!booksMap || !booksMap.has(slug)) {
    return { deleted: false, title, clearedCurrent: false };
  }

  const deletedTitle = booksMap.get(slug);
  booksMap.delete(slug);
  if (booksMap.size === 0) {
    memory.booksByUser.delete(userKey);
  }
  memory.notesByUserAndSlug.delete(memoryNotesKey(userId, slug));

  const current = memory.currentByUser.get(userKey);
  const clearedCurrent = current?.slug === slug;
  if (clearedCurrent) {
    memory.currentByUser.delete(userKey);
  }

  return { deleted: true, title: deletedTitle, clearedCurrent };
}

export async function cleanAllBooks(userId) {
  if (redisConfig()) {
    const slugs = (await redisCommand(["SMEMBERS", keyBookSlugs(userId)])) || [];
    for (const slug of slugs) {
      await redisCommand(["DEL", keyBookNotes(userId, slug)]);
      await redisCommand(["DEL", keyBookTitle(userId, slug)]);
    }
    await redisCommand(["DEL", keyBookSlugs(userId)]);
    await redisCommand(["DEL", keyCurrentSlug(userId)]);
    await redisCommand(["DEL", keyCurrentTitle(userId)]);
    return { deletedCount: slugs.length };
  }

  const userKey = String(userId);
  const booksMap = memory.booksByUser.get(userKey);
  const deletedCount = booksMap ? booksMap.size : 0;

  if (booksMap) {
    for (const slug of booksMap.keys()) {
      memory.notesByUserAndSlug.delete(memoryNotesKey(userId, slug));
    }
  }

  memory.booksByUser.delete(userKey);
  memory.currentByUser.delete(userKey);
  return { deletedCount };
}
