-- Stage 2: Dumpy's tables.
-- Row-level security and access rules come in the next migrations; until they
-- run, nothing here is reachable from the website.

-- Invite codes: 8 characters from an alphabet without look-alikes (no 0/O, 1/I/L).
create or replace function public.generate_invite_code()
returns text
language sql
volatile
set search_path = ''
as $$
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + floor(random() * 31)::int, 1), '')
  from generate_series(1, 8)
$$;

-- One row per housing society.
create table public.societies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  invite_code text not null unique default public.generate_invite_code()
    check (invite_code ~ '^[A-Z0-9]{6,16}$'),
  created_at timestamptz not null default now()
);

-- Who belongs to which society. A person can belong to more than one.
create table public.memberships (
  user_id uuid not null references auth.users (id) on delete cascade,
  society_id uuid not null references public.societies (id) on delete cascade,
  role text not null default 'member' check (role in ('member', 'admin')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'suspended')),
  created_at timestamptz not null default now(),
  primary key (user_id, society_id)
);
create index memberships_society_idx on public.memberships (society_id, status);

-- One profile per person (shared across their societies).
-- flat, phone and upi_id are private: see the row-level security migration.
create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  tower text check (char_length(tower) <= 40),
  flat text check (char_length(flat) <= 20),
  phone text check (phone ~ '^\+?[0-9]{10,13}$'),
  upi_id text check (upi_id ~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9.]{1,63}$'),
  created_at timestamptz not null default now()
);

-- Items people give away (price_inr = 0) or sell.
create table public.listings (
  id uuid primary key default gen_random_uuid(),
  society_id uuid not null references public.societies (id) on delete cascade,
  owner_id uuid not null references auth.users (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 80),
  description text not null default '' check (char_length(description) <= 2000),
  category text not null default 'other'
    check (category in ('furniture', 'electronics', 'kitchen', 'books', 'clothes', 'kids', 'other')),
  condition text not null default 'good'
    check (condition in ('like_new', 'good', 'used', 'for_parts')),
  price_inr integer not null default 0 check (price_inr >= 0),
  status text not null default 'available'
    check (status in ('available', 'reserved', 'done', 'withdrawn', 'hidden', 'expired')),
  expires_at timestamptz not null default (now() + interval '30 days'),
  created_at timestamptz not null default now(),
  -- lets photos and requests point at (listing, society) together, so their
  -- society_id can never disagree with the listing's
  unique (id, society_id)
);
create index listings_feed_idx on public.listings (society_id, status, created_at desc);
create index listings_owner_idx on public.listings (owner_id);

-- Photos of a listing. The file itself lives in the listing-photos bucket.
create table public.listing_photos (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null,
  society_id uuid not null,
  storage_path text not null unique,
  position smallint not null default 0 check (position between 0 and 9),
  created_at timestamptz not null default now(),
  foreign key (listing_id, society_id) references public.listings (id, society_id) on delete cascade,
  -- files must sit at <society_id>/<listing_id>/<file>
  check (storage_path like society_id::text || '/' || listing_id::text || '/_%'
         and storage_path not like '%/%/%/%')
);
create index listing_photos_listing_idx on public.listing_photos (listing_id, position);

-- "I want this" requests.
create table public.requests (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null,
  society_id uuid not null,
  requester_id uuid not null references auth.users (id) on delete cascade,
  message text not null default '' check (char_length(message) <= 500),
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  created_at timestamptz not null default now(),
  foreign key (listing_id, society_id) references public.listings (id, society_id) on delete cascade,
  unique (listing_id, requester_id)
);
create index requests_requester_idx on public.requests (requester_id);
-- At most one accepted request per listing, even if two accepts race.
create unique index requests_one_accepted_idx on public.requests (listing_id) where status = 'accepted';
