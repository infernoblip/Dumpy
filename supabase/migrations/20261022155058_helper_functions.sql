-- Stage 2: helper functions used by row-level security, plus the few
-- functions the website calls for things a plain select must not do.
--
-- All of them are SECURITY DEFINER with an empty search_path: they run with
-- the table owner's rights (so policies can call them without looping back
-- into row-level security) and only ever answer about auth.uid(), the person
-- signed in.

-- True when the signed-in person is an approved member of the society.
create or replace function public.is_member(p_society_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.society_id = p_society_id
      and m.user_id = auth.uid()
      and m.status = 'approved'
  )
$$;

-- True when the signed-in person is an approved admin of the society.
create or replace function public.is_admin(p_society_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.society_id = p_society_id
      and m.user_id = auth.uid()
      and m.status = 'approved'
      and m.role = 'admin'
  )
$$;

-- True when the signed-in person may see another person's public profile
-- fields (name and tower): they are both approved in the same society, or the
-- viewer is an admin of a society the other person belongs to or asked to join.
create or replace function public.can_see_profile(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id = auth.uid() or exists (
    select 1
    from public.memberships me
    join public.memberships them on them.society_id = me.society_id
    where me.user_id = auth.uid()
      and me.status = 'approved'
      and them.user_id = p_user_id
      and (them.status = 'approved' or me.role = 'admin')
  )
$$;

-- True when the signed-in person owns the listing that a Storage path
-- <society_id>/<listing_id>/<file> points at, and is still an approved member.
create or replace function public.owns_listing_path(p_path text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _parts text[] := string_to_array(p_path, '/');
  _society uuid;
  _listing uuid;
begin
  if array_length(_parts, 1) <> 3 or _parts[3] = '' then
    return false;
  end if;
  begin
    _society := _parts[1]::uuid;
    _listing := _parts[2]::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  return exists (
    select 1 from public.listings l
    where l.id = _listing
      and l.society_id = _society
      and l.owner_id = auth.uid()
  ) and public.is_member(_society);
end
$$;

-- True when the signed-in person is an approved member of the society named by
-- the first folder of a Storage path.
create or replace function public.is_member_of_path(p_path text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  _society uuid;
begin
  begin
    _society := split_part(p_path, '/', 1)::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  return public.is_member(_society);
end
$$;

-- Join a society with its invite code. Creates a pending membership that an
-- admin then approves. Calling it again just returns the existing membership.
create or replace function public.join_society(p_invite_code text)
returns table (society_id uuid, status text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  _society uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;

  select s.id into _society
  from public.societies s
  where s.invite_code = upper(btrim(p_invite_code));

  if _society is null then
    raise exception 'That invite code does not match any society' using errcode = 'P0002';
  end if;

  insert into public.memberships (user_id, society_id, role, status)
  values (auth.uid(), _society, 'member', 'pending')
  on conflict on constraint memberships_pkey do nothing;

  return query
    select m.society_id, m.status from public.memberships m
    where m.user_id = auth.uid() and m.society_id = _society;
end
$$;

-- The signed-in person's own full profile, including the private fields
-- (flat, phone, upi_id) that a plain select cannot read.
create or replace function public.get_my_profile()
returns setof public.profiles
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.profiles where user_id = auth.uid()
$$;

-- For the admin page: everyone who belongs to or asked to join the society,
-- with tower and flat so the admin can check they really live there.
-- Returns nothing unless the caller is an approved admin of that society.
create or replace function public.admin_list_members(p_society_id uuid)
returns table (
  user_id uuid,
  display_name text,
  tower text,
  flat text,
  role text,
  status text,
  requested_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select m.user_id, p.display_name, p.tower, p.flat, m.role, m.status, m.created_at
  from public.memberships m
  left join public.profiles p on p.user_id = m.user_id
  where m.society_id = p_society_id
    and public.is_admin(p_society_id)
  order by (m.status = 'pending') desc, m.created_at
$$;

-- Only the person who wrote a request may change its message. Column grants
-- already stop anyone changing which listing, person or society it is for.
create or replace function public.guard_request_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.message is distinct from old.message
     and auth.uid() is distinct from old.requester_id
     and current_user in ('authenticated', 'anon') then
    raise exception 'Only the requester can change the message' using errcode = '42501';
  end if;
  return new;
end
$$;

create trigger requests_guard_update
before update on public.requests
for each row execute function public.guard_request_update();

-- Nobody signed out may call these; signed-in people may.
revoke execute on function
  public.generate_invite_code(),
  public.is_member(uuid),
  public.is_admin(uuid),
  public.can_see_profile(uuid),
  public.owns_listing_path(text),
  public.is_member_of_path(text),
  public.join_society(text),
  public.get_my_profile(),
  public.admin_list_members(uuid),
  public.guard_request_update()
from public, anon;

grant execute on function
  public.is_member(uuid),
  public.is_admin(uuid),
  public.can_see_profile(uuid),
  public.owns_listing_path(text),
  public.is_member_of_path(text),
  public.join_society(text),
  public.get_my_profile(),
  public.admin_list_members(uuid)
to authenticated;

-- Supabase's default privileges also grant execute to authenticated
-- directly, so take back the two that only the database itself uses.
revoke execute on function public.generate_invite_code(), public.guard_request_update() from authenticated;
