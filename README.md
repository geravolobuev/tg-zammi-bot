# tg-book-highlighter

Standalone web app for saving highlights from paper books.

## Stack

- Supabase Auth (email magic link)
- Supabase Postgres (books, notes, current book)
- OpenRouter OCR
- Vercel serverless

## What it does

- sign in by email magic link
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
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `OPENROUTER_API_KEY`
- `OPENROUTER_MODEL`
- `OPENROUTER_OCR_MODEL`

## Supabase setup

Run SQL from `supabase/schema.sql` in the Supabase SQL editor.

In Supabase Auth settings:
- enable Email auth
- enable magic links / OTP email sign-in
- add your site URL to redirect URLs

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

- `supabase/schema.sql` - schema, triggers, indexes, and RLS policies
- `api/config.js` - public Supabase config for the frontend
- `api/ocr.js` - OCR endpoint with Supabase-authenticated access
- `api/lib/supabase.js` - shared Supabase server helpers
- `webapp/index.html` - standalone web UI
