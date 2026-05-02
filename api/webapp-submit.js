import crypto from "node:crypto";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const TELEGRAM_MAX_TEXT_LENGTH = 4096;
const DEFAULT_OPENROUTER_MODEL = "qwen/qwen2.5-vl-72b-instruct:free";

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
    .map(([key, value]) => `${key}=${value}`)
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

async function runOpenRouterOcr(apiKey, imageDataUrl, model = DEFAULT_OPENROUTER_MODEL) {
  const modelCandidates = [...new Set([model, "openrouter/auto", "openrouter/free"])];
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
                text: "Распознай только выделенный фрагмент текста с фото страницы книги. Верни только текст без пояснений."
              },
              {
                type: "image_url",
                image_url: {
                  url: imageDataUrl
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
    if (typeof content === "string" && content.trim()) {
      return content.trim();
    }
    if (Array.isArray(content)) {
      const text = content
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("\n")
        .trim();
      if (text) {
        return text;
      }
    }

    lastRecoverableError = `model=${modelId} empty OCR response`;
  }

  if (lastRecoverableError) {
    throw new Error(`OPENROUTER_API_ERROR: ${lastRecoverableError}`);
  }
  throw new Error("OPENROUTER_NO_TEXT: empty OCR response");
}

function mapUserError(errorMessage) {
  if (errorMessage.includes("OPENROUTER_AUTH_ERROR")) {
    return "Ошибка OpenRouter API ключа. Проверь OPENROUTER_API_KEY в Vercel.";
  }
  if (errorMessage.includes("OPENROUTER_QUOTA_ERROR")) {
    return "У OpenRouter закончилась/недоступна бесплатная квота. Попробуй позже.";
  }
  if (errorMessage.includes("OPENROUTER_NO_TEXT")) {
    return "Не удалось распознать выделения. Попробуй более четкое фото и аккуратные рамки.";
  }
  return "Ошибка обработки выделений. Попробуй еще раз.";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;
  const openRouterModel = normalizeOpenRouterModel(
    process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL
  );
  if (!telegramToken || !openRouterApiKey) {
    res.status(500).json({ ok: false, error: "Missing env vars" });
    return;
  }

  const initData = String(req.body?.initData || "");
  const crops = Array.isArray(req.body?.crops) ? req.body.crops : [];

  if (!initData || crops.length === 0) {
    res.status(400).json({ ok: false, error: "initData and crops are required" });
    return;
  }

  if (crops.length > 12) {
    res.status(400).json({ ok: false, error: "Too many selected regions" });
    return;
  }

  const user = verifyTelegramInitData(initData, telegramToken);
  if (!user?.id) {
    res.status(403).json({ ok: false, error: "Invalid Telegram initData" });
    return;
  }

  const userId = user.id;

  try {
    await telegramRequest(telegramToken, "sendMessage", {
      chat_id: userId,
      text: `Принял ${crops.length} выделений. Обрабатываю...`
    });

    const fragments = [];
    for (let i = 0; i < crops.length; i += 1) {
      const cropData = String(crops[i] || "");
      if (!cropData.startsWith("data:image/")) {
        continue;
      }
      const text = await runOpenRouterOcr(openRouterApiKey, cropData, openRouterModel);
      if (text) {
        fragments.push(text);
      }
    }

    const quoteText = fragments.join("\n\n").trim();
    if (!quoteText) {
      await telegramRequest(telegramToken, "sendMessage", {
        chat_id: userId,
        text: "Не удалось извлечь текст из выделений."
      });
      res.status(200).json({ ok: true, accepted: true });
      return;
    }

    await sendLongMessage(telegramToken, userId, `📚\n\n${quoteText}`);
    await telegramRequest(telegramToken, "sendMessage", {
      chat_id: userId,
      text: "Готово: цитата сохранена в Saved Messages."
    });

    res.status(200).json({ ok: true, accepted: true });
  } catch (error) {
    console.error(error);
    await telegramRequest(telegramToken, "sendMessage", {
      chat_id: userId,
      text: mapUserError(String(error?.message || ""))
    });
    res.status(200).json({ ok: false });
  }
}
