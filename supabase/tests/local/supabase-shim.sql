-- A tiny stand-in for the parts of Supabase our migrations rely on, so the
-- migrations and tests can run on a plain Postgres (for example in CI or a
-- sandbox without Docker). Never run this on a real Supabase project: it
-- already has all of this.
--
-- It creates:
--   roles anon, authenticated, service_role (with Supabase's default grants)
--   auth.users, auth.identities, auth.uid(), auth.role(), auth.jwt()
--   storage.buckets, storage.objects, storage.foldername()

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- Supabase grants everything on new public tables, functions and sequences to
-- the API roles, and relies on row-level security. Mirror that so the
-- migrations' own revokes are tested for real.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  instance_id uuid,
  id uuid primary key,
  aud text,
  role text,
  email text unique,
  encrypted_password text,
  email_confirmed_at timestamptz,
  confirmation_token text,
  recovery_token text,
  email_change_token_new text,
  email_change text,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  created_at timestamptz,
  updated_at timestamptz
);

create table if not exists auth.identities (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  identity_data jsonb not null,
  provider text not null,
  last_sign_in_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  unique (provider_id, provider)
);

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

create or replace function auth.role() returns text language sql stable as $$
  select auth.jwt() ->> 'role'
$$;

grant execute on function auth.jwt(), auth.uid(), auth.role() to anon, authenticated, service_role;

create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  owner uuid,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  owner_id text,
  metadata jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (bucket_id, name)
);

alter table storage.objects enable row level security;
grant all on storage.objects to anon, authenticated, service_role;
grant all on storage.buckets to service_role;
grant select on storage.buckets to anon, authenticated;

create or replace function storage.foldername(name text) returns text[] language plpgsql immutable as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end
$$;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;
