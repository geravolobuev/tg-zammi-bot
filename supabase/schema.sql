create extension if not exists pgcrypto;

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  passcode_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.app_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists app_sessions_user_id_idx on public.app_sessions(user_id);
create index if not exists app_sessions_expires_at_idx on public.app_sessions(expires_at);

create table if not exists public.profiles (
  id uuid primary key references public.app_users(id) on delete cascade,
  current_book_id uuid null,
  created_at timestamptz not null default now()
);

create table if not exists public.books (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  title text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists books_user_id_title_idx
  on public.books (user_id, lower(title));

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  book_id uuid not null references public.books(id) on delete cascade,
  text text not null,
  created_at timestamptz not null default now()
);

create index if not exists notes_book_id_created_at_idx
  on public.notes (book_id, created_at desc);

alter table public.profiles
  drop constraint if exists profiles_current_book_id_fkey;

alter table public.profiles
  add constraint profiles_current_book_id_fkey
  foreign key (current_book_id) references public.books(id) on delete set null;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists books_set_updated_at on public.books;
create trigger books_set_updated_at
  before update on public.books
  for each row execute procedure public.set_updated_at();

alter table public.app_users disable row level security;
alter table public.app_sessions disable row level security;
alter table public.profiles disable row level security;
alter table public.books disable row level security;
alter table public.notes disable row level security;
