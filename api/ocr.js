const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';
const DEFAULT_OCR_MODEL = 'qwen2.5-vl-72b-instruct:free';

function extractTextFromOpenRouterPayload(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n').trim();
  }
  const fallback = payload?.choices?.[0]?.text;
  return typeof fallback === 'string' ? fallback.trim() : '';
}

async function runOpenRouterFullOcr(apiKey, imageDataUrl, preferredModel) {
  const modelCandidates = [
    preferredModel,
    'qwen2.5-vl-72b-instruct:free',
    'google/gemma-3-27b-it:free',
    'mistralai/mistral-small-3.1-24b-instruct:free',
    'google/gemma-3-12b-it:free',
    'nvidia/nemotron-nano-12b-v2-vl:free',
    'openrouter/free'
  ].filter(Boolean);

  let lastRecoverableError = null;
  for (const model of [...new Set(modelCandidates)]) {
    const response = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Извлеки ВЕСЬ текст со страницы книги максимально точно. Верни только чистый текст без комментариев, без markdown, без JSON.'
              },
              {
                type: 'image_url',
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
      if (response.status === 401 || response.status === 403) throw new Error(`OPENROUTER_AUTH_ERROR: ${msg}`);
      if (response.status === 429 || /quota|rate limit|exceeded/i.test(msg)) throw new Error(`OPENROUTER_QUOTA_ERROR: ${msg}`);
      lastRecoverableError = `model=${model} status=${response.status} message=${msg}`;
      continue;
    }

    const text = extractTextFromOpenRouterPayload(payload);
    if (text) return text;
    lastRecoverableError = `model=${model} empty text`;
  }

  throw new Error(`OPENROUTER_OCR_ERROR: ${lastRecoverableError || 'all models failed'}`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
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
    const text = await runOpenRouterFullOcr(openRouterApiKey, imageDataUrl, preferredModel);
    res.status(200).json({ ok: true, text });
  } catch (error) {
    const message = String(error?.message || 'OPENROUTER_OCR_ERROR');
    console.error(error);
    if (message.includes('OPENROUTER_AUTH_ERROR')) {
      res.status(200).json({ ok: false, error: 'OPENROUTER_AUTH_ERROR' });
      return;
    }
    if (message.includes('OPENROUTER_QUOTA_ERROR')) {
      res.status(200).json({ ok: false, error: 'OPENROUTER_QUOTA_ERROR' });
      return;
    }
    res.status(200).json({ ok: false, error: 'OPENROUTER_OCR_ERROR' });
  }
}
