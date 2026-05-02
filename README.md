# tg-book-highlighter

Telegram-бот для сохранения цитат из бумажных книг с OCR через OpenRouter и Telegram Mini App.

## Что умеет

- `/book <название>` - выбрать текущую книгу.
- `/books` - список книг пользователя.
- `/notes <название>` - последние заметки конкретной книги.
- `/last` - 5 последних заметок текущей книги.
- `/app` - открыть Mini App (фото -> OCR -> выбор фрагмента -> сохранение).
- `/limits` - показать usage/limit OpenRouter для текущего API ключа.

Фото в обычном чате с ботом тоже поддерживаются: бот делает OCR и присылает текст, который можно отправить обратно как заметку.

## Хранение данных

Для стабильной работы на Vercel нужно постоянное хранилище.
Используется Upstash Redis (free):

- текущая выбранная книга пользователя
- список книг пользователя
- заметки по каждой книге

Если `UPSTASH_REDIS_REST_URL` и `UPSTASH_REDIS_REST_TOKEN` не заданы, включается in-memory fallback (для локального MVP, без гарантий сохранности).

## Переменные окружения

Скопируй `.env.example` в `.env.local`:

```bash
cp .env.example .env.local
```

Заполни:

- `TELEGRAM_BOT_TOKEN` - токен от `@BotFather`
- `OPENROUTER_API_KEY` - API ключ OpenRouter
- `OPENROUTER_MODEL` - модель OCR для webhook/фото
- `OPENROUTER_OCR_MODEL` - модель OCR для Mini App (full-page OCR)
- `WEBAPP_URL` - URL Mini App, например `https://your-project.vercel.app/webapp`
- `UPSTASH_REDIS_REST_URL` - Upstash Redis REST URL
- `UPSTASH_REDIS_REST_TOKEN` - Upstash Redis REST token
- `TELEGRAM_WEBHOOK_SECRET` - опционально, секрет webhook

## Локальный запуск

```bash
npm i -g vercel
vercel dev
```

Проверка:

- webhook: `http://localhost:3000/api/webhook`
- mini app: `http://localhost:3000/webapp`

## Деплой на Vercel

```bash
vercel --prod
```

После деплоя:

- App URL: `https://your-project.vercel.app`
- Webhook URL: `https://your-project.vercel.app/api/webhook`
- Mini App URL: `https://your-project.vercel.app/webapp`

## Установка webhook

Без секрета:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://your-project.vercel.app/api/webhook"
```

С секретом:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://your-project.vercel.app/api/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Проверка:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

## Структура

- `api/webhook.js` - команды Telegram, OCR фото, сохранение заметок
- `api/lib/book-store.js` - хранение книг и заметок (Upstash Redis + fallback)
- `api/webapp-ocr.js` - OCR полной страницы из Mini App
- `api/webapp-save-text.js` - сохранение выбранного текста из Mini App
- `webapp/index.html` - UI Mini App
