import {
  addBookNote,
  deleteBook,
  getAllBookNotes,
  getBookNotes,
  getCurrentBook,
  listBooks,
  setCurrentBook
} from "./lib/book-store.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const TELEGRAM_MAX_TEXT_LENGTH = 4096;
const DEFAULT_OPENROUTER_MODEL = "qwen/qwen2.5-vl-72b-instruct:free";
const BOT_COMMANDS = [
  { command: "books", description: "Список ваших книг" },
  { command: "notes", description: "Заметки книги: /notes Название" },
  { command: "export", description: "Экспорт заметок в MD" },
  { command: "delete", description: "Удалить книгу: /delete Название" },
  { command: "app", description: "Открыть Mini App" }
];

let commandsSynced = false;
const seenUpdateIds = new Map();

function normalizeOpenRouterModel(model) {
  const value = String(model || "").trim();
  if (!value) {
    return DEFAULT_OPENROUTER_MODEL;
  }
  if (value === "qwen2.5-vl-72b-instruct:free") {
    return DEFAULT_OPENROUTER_MODEL;
  }
  return value;
}

async function telegramRequest(token, method, body) {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(`Telegram API error: ${JSON.stringify(payload)}`);
  }
  return payload.result;
}

async function ensureTelegramCommands(token) {
  if (commandsSynced) {
    return;
  }
  await telegramRequest(token, "setMyCommands", {
    scope: { type: "all_private_chats" },
    commands: BOT_COMMANDS
  });
  await telegramRequest(token, "setMyCommands", {
    scope: { type: "all_private_chats" },
    language_code: "ru",
    commands: BOT_COMMANDS
  });
  commandsSynced = true;
}

function upstashConfig() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return null;
  }
  return { url: url.replace(/\/+$/, ""), token };
}

async function upstashCommand(args) {
  const cfg = upstashConfig();
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

async function isDuplicateUpdate(updateId) {
  const id = Number(updateId);
  if (!Number.isFinite(id)) {
    return false;
  }

  const cfg = upstashConfig();
  if (cfg) {
    const key = `tg:update:${id}`;
    const result = await upstashCommand(["SET", key, "1", "EX", "900", "NX"]);
    return result !== "OK";
  }

  const now = Date.now();
  const ttlMs = 15 * 60 * 1000;
  const prev = seenUpdateIds.get(id);
  if (prev && now - prev < ttlMs) {
    return true;
  }
  seenUpdateIds.set(id, now);
  if (seenUpdateIds.size > 5000) {
    for (const [k, ts] of seenUpdateIds.entries()) {
      if (now - ts > ttlMs) {
        seenUpdateIds.delete(k);
      }
    }
  }
  return false;
}

function splitIntoChunks(text, maxLength = TELEGRAM_MAX_TEXT_LENGTH) {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks = [];
  let rest = text;

  while (rest.length > maxLength) {
    let splitIndex = rest.lastIndexOf("\n", maxLength);
    if (splitIndex < maxLength * 0.5) {
      splitIndex = maxLength;
    }
    chunks.push(rest.slice(0, splitIndex).trim());
    rest = rest.slice(splitIndex).trim();
  }

  if (rest.length) {
    chunks.push(rest);
  }

  return chunks;
}

async function sendLongMessage(token, chatId, text) {
  const chunks = splitIntoChunks(text);
  for (const chunk of chunks) {
    await telegramRequest(token, "sendMessage", {
      chat_id: chatId,
      text: chunk
    });
  }
}

async function getTelegramFileUrl(token, fileId) {
  const result = await telegramRequest(token, "getFile", { file_id: fileId });
  return `${TELEGRAM_API_BASE}/file/bot${token}/${result.file_path}`;
}

async function runOpenRouterOcr(apiKey, imageUrl, model = DEFAULT_OPENROUTER_MODEL) {
  const modelCandidates = [...new Set([model, "openrouter/auto", "openrouter/free"])] ;
  let lastRecoverableError = null;

  for (const modelId of modelCandidates) {
    const response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Распознай весь текст на странице книги. Верни только чистый текст без комментариев."
              },
              {
                type: "image_url",
                image_url: {
                  url: imageUrl
                }
              }
            ]
          }
        ],
        temperature: 0
      })
    });

    const payload = await response.json();
    if (!response.ok) {
      const msg = payload?.error?.message || JSON.stringify(payload);
      const code = payload?.error?.code || response.status;
      const details = `model=${modelId} status=${code} message=${msg}`;

      if (response.status === 401 || response.status === 403) {
        throw new Error(`OPENROUTER_AUTH_ERROR: ${details}`);
      }
      if (response.status === 429 || /quota|rate limit|exceeded/i.test(msg)) {
        throw new Error(`OPENROUTER_QUOTA_ERROR: ${details}`);
      }

      lastRecoverableError = details;
      continue;
    }

    const content = payload?.choices?.[0]?.message?.content;
    const candidateTexts = [];

    if (typeof content === "string") {
      candidateTexts.push(content);
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") {
          candidateTexts.push(part);
        } else if (typeof part?.text === "string") {
          candidateTexts.push(part.text);
        }
      }
    }

    const fallbackText = payload?.choices?.[0]?.text;
    if (typeof fallbackText === "string") {
      candidateTexts.push(fallbackText);
    }

    const merged = candidateTexts.join("\n").replace(/\u0000/g, "").trim();
    if (merged) {
      return merged;
    }

    lastRecoverableError = `model=${modelId} empty OCR response`;
  }

  throw new Error(`OPENROUTER_API_ERROR: ${lastRecoverableError || "OCR failed"}`);
}

function isBooksCommand(text) {
  return /^\/books(?:@\w+)?$/i.test(text.trim());
}

function isAppCommand(text) {
  return /^\/app(?:@\w+)?$/i.test(text.trim()) || /^\/start(?:@\w+)?$/i.test(text.trim());
}

function parseBookCommand(text) {
  const match = text.match(/^\/book(?:@\w+)?\s+(.+)$/is);
  if (!match) return null;
  const title = String(match[1] || "").trim();
  return title || null;
}

function isBookCommandWithoutTitle(text) {
  return /^\/book(?:@\w+)?$/i.test(text.trim());
}

function parseNotesCommand(text) {
  const match = text.match(/^\/notes(?:@\w+)?(?:\s+(.+))?$/is);
  if (!match) {
    return null;
  }
  const hasTitle = typeof match[1] === "string" && match[1].trim().length > 0;
  const title = hasTitle ? String(match[1]).trim() : null;
  return { title };
}

function parseDeleteCommand(text) {
  const match = text.match(/^\/delete(?:@\w+)?\s+(.+)$/is);
  if (!match) return null;
  const title = String(match[1] || "").trim();
  return title || null;
}

function parseExportCommand(text) {
  const match = text.match(/^\/export(?:@\w+)?(?:\s+(.+))?$/is);
  if (!match) return null;
  const title = String(match[1] || "").trim();
  return title || null;
}

function isDeleteCommandWithoutTitle(text) {
  return /^\/delete(?:@\w+)?$/i.test(text.trim());
}

function buildPickBookCallbackData(slug) {
  return `pickbook:${slug}`;
}

function buildExportBookCallbackData(slug) {
  return `exportbook:${slug}`;
}

function parsePickBookCallbackData(data) {
  const match = String(data || "").match(/^pickbook:([a-f0-9]{16})$/i);
  return match ? match[1].toLowerCase() : null;
}

function parseExportBookCallbackData(data) {
  const match = String(data || "").match(/^exportbook:([a-f0-9]{16})$/i);
  return match ? match[1].toLowerCase() : null;
}

function toSafeFileName(title) {
  const safe = String(title || "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (safe || "book").slice(0, 80);
}

function formatMoscowTs(ts) {
  if (!ts) {
    return "";
  }
  const dt = new Date(ts);
  if (Number.isNaN(dt.getTime())) {
    return "";
  }
  return dt.toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function buildBookMarkdown(bookTitle, notes) {
  const nowText = new Date().toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
  const lines = [
    `# ${bookTitle}`,
    "",
    `Экспорт: ${nowText} (Europe/Moscow)`,
    `Количество заметок: ${notes.length}`,
    ""
  ];
  notes.forEach((n, i) => {
    const ts = formatMoscowTs(n.ts);
    lines.push(`## ${i + 1}${ts ? ` (${ts})` : ""}`);
    lines.push(n.text);
    lines.push("");
  });
  return lines.join("\n").trim() + "\n";
}

async function sendMarkdownDocument(token, chatId, fileName, markdownText) {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  const blob = new Blob([markdownText], { type: "text/markdown; charset=utf-8" });
  form.set("document", blob, fileName);

  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/sendDocument`, {
    method: "POST",
    body: form
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(`Telegram API error: ${JSON.stringify(payload)}`);
  }
  return payload.result;
}

async function exportBookToChat(token, chatId, userId, rawTitleOrNull) {
  const result = await getAllBookNotes(userId, rawTitleOrNull);
  if (result.notes.length === 0) {
    await telegramRequest(token, "sendMessage", {
      chat_id: chatId,
      text: `В книге "${result.book.title}" пока нет заметок для экспорта.`
    });
    return;
  }
  const md = buildBookMarkdown(result.book.title, result.notes);
  const fileName = `${toSafeFileName(result.book.title)}.md`;
  await sendMarkdownDocument(token, chatId, fileName, md);
}

function buildWebAppUrl(baseUrl, currentBook) {
  if (!currentBook?.title) {
    return baseUrl;
  }
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("book", currentBook.title);
    return url.toString();
  } catch {
    return baseUrl;
  }
}

async function sendAppLauncher(token, chatId, webAppUrl) {
  await telegramRequest(token, "sendMessage", {
    chat_id: chatId,
    text: "Открой мини-приложение и сохрани текст в выбранную книгу.",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Открыть Highlight App",
            web_app: {
              url: webAppUrl
            }
          }
        ]
      ]
    }
  });
}

async function sendBooksPicker(token, chatId, userId) {
  const books = await listBooks(userId);
  if (books.length === 0) {
    await telegramRequest(token, "sendMessage", {
      chat_id: chatId,
      text: "Пока нет книг. Начни с /book Название книги"
    });
    return;
  }

  const current = await getCurrentBook(userId);
  const inline_keyboard = books.map((b) => ([
    {
      text: `${current?.slug === b.slug ? "✅ " : ""}${b.title}`,
      callback_data: buildPickBookCallbackData(b.slug)
    },
    {
      text: "Экспорт MD",
      callback_data: buildExportBookCallbackData(b.slug)
    }
  ]));

  await telegramRequest(token, "sendMessage", {
    chat_id: chatId,
    text: "Выбери активную книгу:",
    reply_markup: { inline_keyboard }
  });
}

async function fetchOpenRouterLimits(apiKey) {
  const response = await fetch(`${OPENROUTER_API_BASE}/auth/key`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  const payload = await response.json();
  if (!response.ok) {
    const msg = payload?.error?.message || JSON.stringify(payload);
    const code = payload?.error?.code || response.status;
    if (response.status === 401 || response.status === 403) {
      throw new Error(`OPENROUTER_AUTH_ERROR: status=${code} message=${msg}`);
    }
    throw new Error(`OPENROUTER_LIMITS_ERROR: status=${code} message=${msg}`);
  }

  const data = payload?.data || {};
  const usage = data?.usage ?? data?.used_credits ?? data?.total_usage ?? null;
  const limit = data?.limit ?? data?.credit_limit ?? data?.hard_limit ?? null;
  const remaining =
    typeof limit === "number" && typeof usage === "number"
      ? Math.max(limit - usage, 0)
      : null;

  return { usage, limit, remaining };
}

async function saveNoteAndNotify(token, chatId, userId, text) {
  const book = await addBookNote(userId, text);
  const payloadText = `📚 ${book.title}\n\n${text}`;

  await sendLongMessage(token, userId, payloadText);
  await telegramRequest(token, "sendMessage", {
    chat_id: chatId,
    text: `Сохранено в книгу: ${book.title}`
  });
}

async function handleTextMessage(token, openRouterApiKey, openRouterModel, webAppUrl, message) {
  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = (message.text || "").trim();

  const bookTitle = parseBookCommand(text);
  if (bookTitle) {
    const book = await setCurrentBook(userId, bookTitle);
    await telegramRequest(token, "sendMessage", {
      chat_id: chatId,
      text: `Текущая книга: ${book.title}`
    });
    return;
  }

  if (isBookCommandWithoutTitle(text)) {
    await telegramRequest(token, "sendMessage", {
      chat_id: chatId,
      text: "Используй формат: /book Название книги"
    });
    return;
  }

  if (isBooksCommand(text)) {
    await sendBooksPicker(token, chatId, userId);
    return;
  }

  const notesTitle = parseNotesCommand(text);
  if (notesTitle !== null) {
    const limit = 5;
    const queryTitle = notesTitle.title;

    let result;
    try {
      result = await getBookNotes(userId, queryTitle, limit);
    } catch (error) {
      if (String(error?.message || "").includes("BOOK_NOT_SELECTED")) {
        await telegramRequest(token, "sendMessage", {
          chat_id: chatId,
          text: "Сначала выбери книгу: /book Название книги"
        });
        return;
      }
      throw error;
    }

    if (result.notes.length === 0) {
      await telegramRequest(token, "sendMessage", {
        chat_id: chatId,
        text: `В книге "${result.book.title}" пока нет заметок.`
      });
      return;
    }

    const body = result.notes
      .slice()
      .reverse()
      .map((n, i) => `${i + 1}. ${n.text}`)
      .join("\n\n");

    await sendLongMessage(token, chatId, `Заметки: ${result.book.title}\n\n${body}`);
    return;
  }

  const exportTitle = parseExportCommand(text);
  if (exportTitle !== null) {
    try {
      await exportBookToChat(token, chatId, userId, exportTitle);
    } catch (error) {
      if (String(error?.message || "").includes("BOOK_NOT_SELECTED")) {
        await telegramRequest(token, "sendMessage", {
          chat_id: chatId,
          text: "Сначала выбери книгу: /book Название книги"
        });
        return;
      }
      throw error;
    }
    return;
  }

  const deleteTitle = parseDeleteCommand(text);
  if (deleteTitle) {
    const result = await deleteBook(userId, deleteTitle);
    if (!result.deleted) {
      await telegramRequest(token, "sendMessage", {
        chat_id: chatId,
        text: `Книга "${deleteTitle}" не найдена.`
      });
      return;
    }

    const suffix = result.clearedCurrent
      ? "\nТекущая книга сброшена. Выбери новую: /book Название книги"
      : "";

    await telegramRequest(token, "sendMessage", {
      chat_id: chatId,
      text: `Удалена книга: ${result.title}${suffix}`
    });
    return;
  }

  if (isDeleteCommandWithoutTitle(text)) {
    await telegramRequest(token, "sendMessage", {
      chat_id: chatId,
      text: "Используй формат: /delete Название книги"
    });
    return;
  }

  if (isAppCommand(text)) {
    const current = await getCurrentBook(userId);
    const appUrl = buildWebAppUrl(webAppUrl, current);
    await sendAppLauncher(token, chatId, appUrl);
    return;
  }

  if (text.startsWith("/")) {
    await telegramRequest(token, "sendMessage", {
      chat_id: chatId,
      text:
        "Команды:\n" +
        "/books - список книг\n" +
        "/notes <название> - заметки по книге\n" +
        "/export [название] - экспорт заметок в MD\n" +
        "/delete <название> - удалить книгу\n" +
        "/app - открыть мини-приложение"
    });
    return;
  }

  try {
    await saveNoteAndNotify(token, chatId, userId, text);
  } catch (error) {
    if (String(error?.message || "").includes("BOOK_NOT_SELECTED")) {
      await telegramRequest(token, "sendMessage", {
        chat_id: chatId,
        text: "Сначала выбери книгу: /book Название книги"
      });
      return;
    }
    throw error;
  }
}

async function handlePhotoMessage(token, ocrApiKey, ocrModel, message) {
  const chatId = message.chat.id;

  const photo = message.photo?.[message.photo.length - 1];
  if (!photo) {
    return;
  }

  await telegramRequest(token, "sendMessage", {
    chat_id: chatId,
    text: "Обрабатываю фото, подожди..."
  });

  const fileUrl = await getTelegramFileUrl(token, photo.file_id);
  const recognizedText = await runOpenRouterOcr(ocrApiKey, fileUrl, ocrModel);

  const responseText = `${recognizedText}\n\nСкопируй нужный фрагмент и отправь мне`;
  await sendLongMessage(token, chatId, responseText);
}

async function handleCallbackQuery(token, callbackQuery) {
  const userId = callbackQuery?.from?.id;
  const chatId = callbackQuery?.message?.chat?.id;
  const callbackId = callbackQuery?.id;
  const data = String(callbackQuery?.data || "");

  if (!userId || !chatId || !callbackId) {
    return;
  }

  const pickedSlug = parsePickBookCallbackData(data);
  const exportSlug = parseExportBookCallbackData(data);
  if (!pickedSlug && !exportSlug) {
    await telegramRequest(token, "answerCallbackQuery", {
      callback_query_id: callbackId,
      text: "Неизвестное действие",
      show_alert: false
    });
    return;
  }

  const books = await listBooks(userId);
  const selected = books.find((b) => b.slug === (pickedSlug || exportSlug));
  if (!selected) {
    await telegramRequest(token, "answerCallbackQuery", {
      callback_query_id: callbackId,
      text: "Книга не найдена",
      show_alert: false
    });
    return;
  }

  if (exportSlug) {
    await telegramRequest(token, "answerCallbackQuery", {
      callback_query_id: callbackId,
      text: `Готовлю экспорт: ${selected.title}`,
      show_alert: false
    });
    await exportBookToChat(token, chatId, userId, selected.title);
    return;
  }

  const book = await setCurrentBook(userId, selected.title);

  await telegramRequest(token, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text: `Активная книга: ${book.title}`,
    show_alert: false
  });

  try {
    const refreshedBooks = await listBooks(userId);
    const inline_keyboard = refreshedBooks.map((b) => ([
      {
        text: `${b.slug === book.slug ? "✅ " : ""}${b.title}`,
        callback_data: buildPickBookCallbackData(b.slug)
      },
      {
        text: "Экспорт MD",
        callback_data: buildExportBookCallbackData(b.slug)
      }
    ]));

    await telegramRequest(token, "editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: callbackQuery.message.message_id,
      reply_markup: { inline_keyboard }
    });
  } catch (error) {
    console.error("Failed to refresh picker:", error);
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    res.status(200).json({ ok: true, message: "Telegram webhook is running" });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;
  const openRouterModel = normalizeOpenRouterModel(
    process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL
  );
  const webAppUrl = process.env.WEBAPP_URL || `https://${req.headers.host}/webapp`;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!token || !openRouterApiKey) {
    res.status(500).json({
      ok: false,
      error: "TELEGRAM_BOT_TOKEN and OPENROUTER_API_KEY must be set"
    });
    return;
  }

  if (webhookSecret) {
    const incomingSecret = req.headers["x-telegram-bot-api-secret-token"];
    if (incomingSecret !== webhookSecret) {
      res.status(403).json({ ok: false, error: "Invalid webhook secret" });
      return;
    }
  }

  try {
    try {
      await ensureTelegramCommands(token);
    } catch (cmdError) {
      console.error("setMyCommands failed:", cmdError);
    }

    const update = req.body;
    const updateId = update?.update_id;
    if (await isDuplicateUpdate(updateId)) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }

    if (update?.callback_query) {
      await handleCallbackQuery(token, update.callback_query);
      res.status(200).json({ ok: true });
      return;
    }

    const message = update?.message;

    if (!message) {
      res.status(200).json({ ok: true, ignored: true });
      return;
    }

    if (message.photo?.length) {
      await handlePhotoMessage(token, openRouterApiKey, openRouterModel, message);
      res.status(200).json({ ok: true });
      return;
    }

    if (message.text) {
      await handleTextMessage(token, openRouterApiKey, openRouterModel, webAppUrl, message);
      res.status(200).json({ ok: true });
      return;
    }

    await telegramRequest(token, "sendMessage", {
      chat_id: message.chat.id,
      text: "Поддерживаются только текст и фото."
    });

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    try {
      const chatId = req.body?.message?.chat?.id;
      const tokenForFallback = process.env.TELEGRAM_BOT_TOKEN;
      if (chatId && tokenForFallback) {
        const message = String(error?.message || "");
        let userText = "Ошибка обработки. Попробуй еще раз.";

        if (message.includes("OPENROUTER_AUTH_ERROR")) {
          userText = "Ошибка OpenRouter API ключа. Проверь OPENROUTER_API_KEY в Vercel.";
        } else if (message.includes("OPENROUTER_QUOTA_ERROR")) {
          userText =
            "У OpenRouter закончилась/недоступна бесплатная квота. Попробуй позже или другой ключ.";
        } else if (message.includes("OPENROUTER_NO_TEXT")) {
          userText =
            "Модель не вернула текст с этого фото. Отправь более четкое фото страницы без сильных бликов.";
        }

        await telegramRequest(tokenForFallback, "sendMessage", {
          chat_id: chatId,
          text: userText
        });
      }
    } catch (fallbackError) {
      console.error("Fallback message error:", fallbackError);
    }
    res.status(200).json({ ok: false });
  }
}
