import { requireSessionUser } from './lib/auth.js';

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_OCR_MODEL = 'qwen2.5-vl-72b-instruct:free';
const DEFAULT_FALLBACK_MODELS = [
  'qwen2.5-vl-72b-instruct:free',
  'mistralai/mistral-small-3.1-24b-instruct:free',
  'google/gemma-3-27b-it:free',
  'google/gemma-3-12b-it:free',
  'nvidia/nemotron-nano-12b-v2-vl:free'
];

function extractTextFromOpenRouterPayload(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('\n')
      .trim();
  }
  const fallback = payload?.choices?.[0]?.text;
  return typeof fallback === 'string' ? fallback.trim() : '';
}

function getModelChain(preferredModel) {
  const envFallbacks = String(process.env.OPENROUTER_OCR_FALLBACKS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return [...new Set([preferredModel, ...envFallbacks, ...DEFAULT_FALLBACK_MODELS].filter(Boolean))];
}

async function fetchWithTimeout(url, options, timeoutMs = 45000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function tryModel(apiKey, imageDataUrl, model) {
  const response = await fetchWithTimeout(`${OPENROUTER_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': process.env.APP_BASE_URL || 'https://tg-book-highlighter.vercel.app',
      'X-Title': 'Book Highlighter OCR'
    },
    body: JSON.stringify({
      model,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Извлеки ВЕСЬ текст со страницы книги максимально точно. Сохрани абзацы и переносы строк по смыслу. Верни только чистый текст без комментариев, без markdown, без JSON.'
          },
          {
            type: 'image_url',
            image_url: { url: imageDataUrl }
          }
        ]
      }],
      temperature: 0
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = payload?.error?.message || JSON.stringify(payload) || 'OPENROUTER_REQUEST_FAILED';
    return { ok: false, status: response.status, model, message: msg };
  }

  const text = extractTextFromOpenRouterPayload(payload);
  if (!text) {
    return { ok: false, status: 200, model, message: 'EMPTY_TEXT' };
  }

  return { ok: true, model, text };
}

async function runOpenRouterFullOcr(apiKey, imageDataUrl, preferredModel) {
  const results = [];

  for (const model of getModelChain(preferredModel)) {
    try {
      const result = await tryModel(apiKey, imageDataUrl, model);
      results.push(result);
      if (result.ok) return { text: result.text, model: result.model, attempts: results };

      const message = String(result.message || '');
      if (result.status === 401 || result.status === 403) {
        throw new Error(`OPENROUTER_AUTH_ERROR: ${message}`);
      }
    } catch (error) {
      const message = String(error?.message || error || 'UNKNOWN_ERROR');
      if (message.includes('OPENROUTER_AUTH_ERROR')) throw error;
      results.push({ ok: false, status: 0, model, message });
    }
  }

  const sawQuota = results.some((item) => item.status === 429 || /quota|rate limit|exceeded/i.test(String(item.message || '')));
  const sawNetwork = results.some((item) => /abort|timed out|fetch failed|network/i.test(String(item.message || '')));

  if (sawQuota) {
    throw new Error(`OPENROUTER_QUOTA_ERROR: ${JSON.stringify(results.slice(-3))}`);
  }
  if (sawNetwork) {
    throw new Error(`OPENROUTER_NETWORK_ERROR: ${JSON.stringify(results.slice(-3))}`);
  }
  throw new Error(`OPENROUTER_OCR_ERROR: ${JSON.stringify(results.slice(-3))}`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  try {
    await requireSessionUser(req);
  } catch {
    res.status(401).json({ ok: false, error: 'AUTH_REQUIRED' });
    return;
  }

  const openRouterApiKey = process.env.OPENROUTER_API_KEY;
  const preferredModel = process.env.OPENROUTER_OCR_MODEL || process.env.OPENROUTER_MODEL || DEFAULT_OCR_MODEL;
  if (!openRouterApiKey) {
    res.status(500).json({ ok: false, error: 'OPENROUTER_API_KEY is required' });
    return;
  }

  const imageDataUrl = String(req.body?.imageDataUrl || '');
  if (!imageDataUrl.startsWith('data:image/')) {
    res.status(400).json({ ok: false, error: 'imageDataUrl is required' });
    return;
  }

  try {
    const result = await runOpenRouterFullOcr(openRouterApiKey, imageDataUrl, preferredModel);
    res.status(200).json({ ok: true, text: result.text, model: result.model });
  } catch (error) {
    const message = String(error?.message || 'OPENROUTER_OCR_ERROR');
    console.error('OCR error:', message);

    if (message.includes('OPENROUTER_AUTH_ERROR')) {
      return res.status(200).json({ ok: false, error: 'OPENROUTER_AUTH_ERROR' });
    }
    if (message.includes('OPENROUTER_QUOTA_ERROR')) {
      return res.status(200).json({ ok: false, error: 'OPENROUTER_QUOTA_ERROR' });
    }
    if (message.includes('OPENROUTER_NETWORK_ERROR')) {
      return res.status(200).json({ ok: false, error: 'OPENROUTER_NETWORK_ERROR' });
    }
    return res.status(200).json({ ok: false, error: 'OPENROUTER_OCR_ERROR' });
  }
}
