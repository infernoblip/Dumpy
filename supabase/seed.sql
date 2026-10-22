-- Demo data for trying Dumpy out. Everything here is made up:
-- "Demo Society", two demo people and five demo items. No real names or flats.
--
-- Loads automatically with `supabase db reset` on a local stack. On the real
-- project it is optional; supabase/snippets/remove-demo-data.sql takes it out.
--
-- The demo people cannot sign in by magic link (their example.com addresses
-- never receive mail); they exist so the feed has something in it.

-- Demo people
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  ('00000000-0000-0000-0000-000000000000', 'd0000000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'demo.owner@example.com', '', now(),
   '', '', '', '', '{"provider":"email","providers":["email"]}', '{}', now(), now()),
  ('00000000-0000-0000-0000-000000000000', 'd0000000-0000-4000-8000-000000000002',
   'authenticated', 'authenticated', 'demo.neighbour@example.com', '', now(),
   '', '', '', '', '{"provider":"email","providers":["email"]}', '{}', now(), now())
on conflict (id) do nothing;

insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
values
  ('d0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
   '{"sub":"d0000000-0000-4000-8000-000000000001","email":"demo.owner@example.com","email_verified":true}',
   'email', now(), now(), now()),
  ('d0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000002',
   '{"sub":"d0000000-0000-4000-8000-000000000002","email":"demo.neighbour@example.com","email_verified":true}',
   'email', now(), now(), now())
on conflict (provider_id, provider) do nothing;

-- Demo Society
insert into public.societies (id, name, invite_code)
values ('5d000000-0000-4000-8000-000000000001', 'Demo Society', 'DEMO2345')
on conflict (id) do nothing;

insert into public.memberships (user_id, society_id, role, status) values
  ('d0000000-0000-4000-8000-000000000001', '5d000000-0000-4000-8000-000000000001', 'admin',  'approved'),
  ('d0000000-0000-4000-8000-000000000002', '5d000000-0000-4000-8000-000000000001', 'member', 'approved')
on conflict (user_id, society_id) do nothing;

insert into public.profiles (user_id, display_name, tower, flat, phone, upi_id) values
  ('d0000000-0000-4000-8000-000000000001', 'Demo Owner',     'A', 'A-101', '9000000001', 'demo.owner@upi'),
  ('d0000000-0000-4000-8000-000000000002', 'Demo Neighbour', 'B', 'B-202', null,         null)
on conflict (user_id) do nothing;

-- Five demo items: three free, two paid
insert into public.listings (id, society_id, owner_id, title, description, category, condition, price_inr, created_at) values
  ('1d000000-0000-4000-8000-000000000001', '5d000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
   'Wooden study table', 'Sturdy table, 4 ft wide. A few scratches on top.', 'furniture', 'good', 0, now() - interval '2 days'),
  ('1d000000-0000-4000-8000-000000000002', '5d000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
   'Mixer grinder', 'Works fine, three jars. Upgraded to a new one.', 'kitchen', 'used', 400, now() - interval '1 day'),
  ('1d000000-0000-4000-8000-000000000003', '5d000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001',
   'Class 8 NCERT textbooks', 'Full set, some pencil marks.', 'books', 'good', 0, now() - interval '5 hours'),
  ('1d000000-0000-4000-8000-000000000004', '5d000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002',
   'Kids cycle (16 inch)', 'Outgrown. Training wheels included.', 'kids', 'like_new', 1200, now() - interval '3 days'),
  ('1d000000-0000-4000-8000-000000000005', '5d000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000002',
   'Old Wi-Fi router', 'Powers on, one antenna loose. Good for spares.', 'electronics', 'for_parts', 0, now() - interval '20 minutes')
on conflict (id) do nothing;

-- One pending request, so the owner's My items page has something to show
insert into public.requests (listing_id, society_id, requester_id, message) values
  ('1d000000-0000-4000-8000-000000000001', '5d000000-0000-4000-8000-000000000001',
   'd0000000-0000-4000-8000-000000000002', 'Could I pick this up on Saturday morning?')
on conflict (listing_id, requester_id) do nothing;
