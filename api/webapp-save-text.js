import crypto from "node:crypto";
import { addBookNote } from "./lib/book-store.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const TELEGRAM_MAX_TEXT_LENGTH = 4096;

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

async function telegramRequest(token, method, body) {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(`Telegram API error: ${JSON.stringify(payload)}`);
  }
  return payload.result;
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

function verifyTelegramInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) {
    return null;
  }

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const calculatedHash = crypto
    .createHmac("sha256", secret)
    .update(dataCheckString)
    .digest("hex");

  if (calculatedHash !== hash) {
    return null;
  }

  const userJson = params.get("user");
  if (!userJson) {
    return null;
  }
  const user = JSON.parse(userJson);
  return user?.id ? user : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!telegramToken) {
    res.status(500).json({ ok: false, error: "Missing env vars" });
    return;
  }

  const initData = String(req.body?.initData || "");
  const text = String(req.body?.text || "").trim();
  const bookTitle = String(req.body?.bookTitle || "").trim();

  if (!initData || !text) {
    res.status(400).json({ ok: false, error: "initData and text are required" });
    return;
  }

  const user = verifyTelegramInitData(initData, telegramToken);
  if (!user?.id) {
    res.status(403).json({ ok: false, error: "Invalid Telegram initData" });
    return;
  }

  try {
    const book = await addBookNote(user.id, text, {
      bookTitle: bookTitle || undefined
    });

    await sendLongMessage(telegramToken, user.id, `📚 ${book.title}\n\n${text}`);
    await telegramRequest(telegramToken, "sendMessage", {
      chat_id: user.id,
      text: `Готово: текст сохранен в книгу "${book.title}".`
    });

    res.status(200).json({ ok: true, book: book.title });
  } catch (error) {
    console.error(error);
    const msg = String(error?.message || "");
    if (msg.includes("BOOK_NOT_SELECTED")) {
      res.status(200).json({ ok: false, error: "BOOK_NOT_SELECTED" });
      return;
    }
    res.status(200).json({ ok: false, error: "SAVE_FAILED" });
  }
}
