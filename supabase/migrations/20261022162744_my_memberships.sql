-- Stage 4: the signed-in person's own memberships, with each society's name.
--
-- The website calls this on every page to decide what to show: the app,
-- the "waiting for approval" screen, or the join page. A plain select on
-- societies can't do it, because people who are still pending (or suspended)
-- may not read their society's row. Showing them just the name of the society
-- they asked to join is fine: they already had its invite code.
--
-- No table changes.

create or replace function public.my_memberships()
returns table (
  society_id uuid,
  society_name text,
  role text,
  status text,
  requested_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select m.society_id, s.name, m.role, m.status, m.created_at
  from public.memberships m
  join public.societies s on s.id = m.society_id
  where m.user_id = auth.uid()
  order by (m.status = 'approved') desc, m.created_at
$$;

revoke execute on function public.my_memberships() from public, anon;
grant execute on function public.my_memberships() to authenticated;
