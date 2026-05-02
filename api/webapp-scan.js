import crypto from "node:crypto";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_MODEL = "qwen/qwen2.5-vl-72b-instruct:free";

function normalizeOpenRouterModel(model) {
  const value = String(model || "").trim();
  if (!value || value === "qwen2.5-vl-72b-instruct:free") {
    return DEFAULT_OPENROUTER_MODEL;
  }
  return value;
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

function extractJsonObject(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < 0 || end <= start) {
    return null;
  }
  const candidate = text.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function clamp01(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function normalizeScannedWords(words) {
  if (!Array.isArray(words)) {
    return [];
  }

  return words
    .map((word) => {
      const text = String(word?.text || word?.word || "")
        .replace(/\s+/g, " ")
        .trim();
      const bbox = word?.bbox || {};
      const x = clamp01(bbox.x);
      const y = clamp01(bbox.y);
      const w = clamp01(bbox.w);
      const h = clamp01(bbox.h);
      if (!text || w <= 0 || h <= 0) {
        return null;
      }
      return { text, bbox: { x, y, w, h } };
    })
    .filter(Boolean)
    .slice(0, 800);
}

async function runPageScan(apiKey, imageDataUrl, model) {
  const modelCandidates = [...new Set([model, "openrouter/auto", "openrouter/free"])];
  let lastError = null;

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
                text:
                  "Распознай весь текст страницы книги и верни ТОЛЬКО JSON в формате: " +
                  '{"words":[{"text":"слово","bbox":{"x":0.12,"y":0.34,"w":0.08,"h":0.03}}]}. ' +
                  "bbox должен быть НОРМАЛИЗОВАН: x,y,w,h в диапазоне 0..1 относительно всей страницы. " +
                  "Каждый объект в words = одно слово. " +
                  "Без markdown и без комментариев."
              },
              {
                type: "image_url",
                image_url: { url: imageDataUrl }
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
      lastError = details;
      continue;
    }

    const content = payload?.choices?.[0]?.message?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((p) => p?.text || "").join("\n")
          : "";
    const normalized = String(text || "").trim();
    if (!normalized) {
      lastError = `model=${modelId} empty response`;
      continue;
    }

    const parsed = extractJsonObject(normalized);
    if (parsed?.words && Array.isArray(parsed.words)) {
      const words = normalizeScannedWords(parsed.words);
      if (words.length > 0) {
        return words;
      }
    }

    if (parsed?.lines && Array.isArray(parsed.lines)) {
      const words = normalizeScannedWords(
        parsed.lines.flatMap((line) =>
          String(line?.text || line?.line || "")
            .split(/\s+/)
            .filter(Boolean)
            .map((w) => ({ text: w, bbox: line?.bbox }))
        )
      );
      if (words.length > 0) {
        return words;
      }
    }

    const fallbackWords = normalized
      .split(/\n+/)
      .flatMap((line) =>
        String(line || "")
          .trim()
          .split(/\s+/)
      )
      .filter(Boolean)
      .slice(0, 400)
      .map((text, i, arr) => ({
        text,
        bbox: {
          x: 0.04,
          y: Math.min(0.96, 0.04 + i * (0.9 / Math.max(arr.length, 1))),
          w: 0.2,
          h: 0.9 / Math.max(arr.length, 1)
        }
      }));
    if (fallbackWords.length > 0) {
      return fallbackWords;
    }

    if (normalized.length > 0) {
      return [
        {
          text: normalized.slice(0, 4000),
          bbox: { x: 0.03, y: 0.03, w: 0.94, h: 0.94 }
        }
      ];
    }

    lastError = `model=${modelId} no lines parsed`;
  }

  throw new Error(`OPENROUTER_API_ERROR: ${lastError || "scan failed"}`);
}

function mapUserError(errorMessage) {
  if (errorMessage.includes("OPENROUTER_AUTH_ERROR")) {
    return "Ошибка OpenRouter API ключа. Проверь OPENROUTER_API_KEY в Vercel.";
  }
  if (errorMessage.includes("OPENROUTER_QUOTA_ERROR")) {
    return "У OpenRouter закончилась/недоступна квота. Попробуй позже.";
  }
  return "Не удалось просканировать страницу. Попробуй более четкое фото.";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }

  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;
  const openRouterModel = normalizeOpenRouterModel(process.env.OPENROUTER_MODEL);
  if (!telegramToken || !openRouterApiKey) {
    res.status(500).json({ ok: false, error: "Missing env vars" });
    return;
  }

  const initData = String(req.body?.initData || "");
  const imageDataUrl = String(req.body?.imageDataUrl || "");
  if (!initData || !imageDataUrl.startsWith("data:image/")) {
    res.status(400).json({ ok: false, error: "initData and imageDataUrl are required" });
    return;
  }

  const user = verifyTelegramInitData(initData, telegramToken);
  if (!user?.id) {
    res.status(403).json({ ok: false, error: "Invalid Telegram initData" });
    return;
  }

  try {
    const words = await runPageScan(openRouterApiKey, imageDataUrl, openRouterModel);
    res.status(200).json({ ok: true, words });
  } catch (error) {
    console.error(error);
    try {
      await telegramRequest(telegramToken, "sendMessage", {
        chat_id: user.id,
        text: mapUserError(String(error?.message || ""))
      });
    } catch {
      // ignore telegram fallback errors
    }
    res.status(200).json({ ok: false, error: "SCAN_FAILED" });
  }
}
