# tg-book-highlighter

Standalone web app for saving highlights from paper books with OCR via OpenRouter and storage in Upstash Redis.

## What it does

- create and switch between books
- keep one active book
- upload or photograph a page
- OCR the full page through OpenRouter
- edit the recognized text
- save either the selected fragment or the whole text
- view the latest 5 notes for the active or selected book
- export a book's notes as Markdown
- delete a book with all its notes

## Architecture

- frontend: `/webapp/index.html`
- backend API: Vercel serverless functions
- OCR: OpenRouter vision models
- storage: Upstash Redis

## Current auth model

This web-only MVP uses a browser-persisted local user ID stored in `localStorage`.

Implication:
- the same browser keeps access to the same books/notes
- another browser/device will look like a different user until real auth is added

## Environment variables

Copy `.env.example` to `.env.local`:

```bash
cp .env.example .env.local
```

Fill in:

- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`
- `OPENROUTER_OCR_MODEL`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

## Local run

```bash
npm i
vercel dev
```

Open:

- `http://localhost:3000/`

## Deploy to Vercel

```bash
vercel --prod
```

## API endpoints

- `GET /api/books` - list books + current book
- `POST /api/books` - create/select active book (`{ title }`)
- `DELETE /api/books?title=...` - delete book
- `GET /api/notes?title=...` - last 5 notes for a book or current book
- `POST /api/notes` - save note (`{ text, bookTitle? }`)
- `GET /api/export?title=...` - download Markdown export
- `POST /api/ocr` - OCR a page (`{ imageDataUrl }`)

All API requests identify the current browser via `x-user-id` header set by the frontend.

## Main files

- `api/lib/book-store.js` - Upstash-backed storage for books and notes
- `api/books.js` - book CRUD + active book selection
- `api/notes.js` - save note + latest 5 notes
- `api/export.js` - Markdown export
- `api/ocr.js` - OCR through OpenRouter
- `webapp/index.html` - standalone web UI
