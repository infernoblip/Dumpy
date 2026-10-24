-- How the launch is going, per society: households signed up and items that
-- have changed hands. Read-only. Run it in the Supabase dashboard:
-- SQL Editor > New query, paste this file, Run.
-- Stage 11 is done when a society shows at least 10 households and 5 items
-- changed hands. A household is one tower + flat, so two people from the same
-- flat count once.

select
  s.name as society,
  (select count(distinct lower(coalesce(p.tower, '')) || '/' || lower(coalesce(p.flat, '')))
     from public.memberships m
     join public.profiles p on p.user_id = m.user_id
    where m.society_id = s.id and m.status = 'approved')                         as households,
  (select count(*) from public.memberships m
    where m.society_id = s.id and m.status = 'approved')                         as members,
  (select count(*) from public.memberships m
    where m.society_id = s.id and m.status = 'pending')                          as waiting_for_approval,
  (select count(*) from public.listings l where l.society_id = s.id)             as items_posted,
  (select count(*) from public.listings l
    where l.society_id = s.id and l.status in ('available', 'reserved'))         as items_up_now,
  (select count(*) from public.listings l
    where l.society_id = s.id and l.status = 'done')                             as items_changed_hands
from public.societies s
order by households desc;
