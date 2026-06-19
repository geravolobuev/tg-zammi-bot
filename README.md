# tg-book-highlighter

Standalone web app for saving highlights from paper books.

## Stack

- Supabase Postgres
- simple custom auth: username + passcode + httpOnly cookie session
- OpenRouter OCR
- Vercel serverless

## What it does

- simple sign in / sign up using username + passcode
- create and switch between books
- keep one active book per user
- upload or photograph a page
- OCR the full page through OpenRouter
- edit the recognized text
- save either the selected fragment or the whole text
- view the latest 5 notes for the active or selected book
- export a book's notes as Markdown
- delete a book with all its notes

## Environment variables

Copy `.env.example` to `.env.local`:

```bash
cp .env.example .env.local
```

Fill in:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`
- `OPENROUTER_OCR_MODEL`

## Supabase setup

Run SQL from `supabase/schema.sql` in the Supabase SQL editor.

This version does not use Supabase Auth. It uses its own simple session tables inside Postgres.

## Local run

```bash
vercel dev
```

Open:

- `http://localhost:3000/`

## Deploy to Vercel

```bash
vercel --prod
```

## Files

- `supabase/schema.sql` - schema for users, sessions, books, notes
- `api/auth.js` - sign in / sign up / sign out / current session
- `api/data.js` - books, active book, notes
- `api/ocr.js` - OCR endpoint protected by session cookie
- `api/lib/auth.js` - cookie session helpers
- `api/lib/supabase.js` - Supabase admin client
- `webapp/index.html` - standalone web UI
