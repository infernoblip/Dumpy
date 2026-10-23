-- Test data for the local browser test. Made up: Demo Society, example.com people.
insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at) values
 ('aaaaaaaa-0000-4000-8000-000000000001','authenticated','authenticated','demo.admin@example.com', now(), now(), now()),
 ('aaaaaaaa-0000-4000-8000-000000000002','authenticated','authenticated','new.neighbour@example.com', now(), now(), now()),
 ('aaaaaaaa-0000-4000-8000-000000000003','authenticated','authenticated','demo.owner@example.com', now(), now(), now());
insert into public.societies (id, name, invite_code) values ('5d000000-0000-4000-8000-000000000001','Demo Society','DEMO2345');
insert into public.memberships (user_id, society_id, role, status) values
 ('aaaaaaaa-0000-4000-8000-000000000001','5d000000-0000-4000-8000-000000000001','admin','approved'),
 ('aaaaaaaa-0000-4000-8000-000000000003','5d000000-0000-4000-8000-000000000001','member','approved');
insert into public.profiles (user_id, display_name, tower, flat, phone) values
 ('aaaaaaaa-0000-4000-8000-000000000001','Demo Admin','A','A-101','9000000001'),
 ('aaaaaaaa-0000-4000-8000-000000000003','Demo Owner','B','B-202',null);
insert into public.listings (id, society_id, owner_id, title, description, category, condition, price_inr, created_at) values
 ('11111111-0000-4000-8000-000000000001','5d000000-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000003','Wooden study chair','Sturdy, one scratch on a leg.','furniture','good',0, now() - interval '3 hours'),
 ('11111111-0000-4000-8000-000000000002','5d000000-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000003','Bedside lamp','Warm light, bulb included.','electronics','like_new',150, now() - interval '1 day'),
 ('11111111-0000-4000-8000-000000000003','5d000000-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000001','Box of storybooks','About 20 books for ages 5 to 8.','books','used',0, now() - interval '2 days');
insert into public.listing_photos (listing_id, society_id, storage_path, position) values
 ('11111111-0000-4000-8000-000000000001','5d000000-0000-4000-8000-000000000001','5d000000-0000-4000-8000-000000000001/11111111-0000-4000-8000-000000000001/chair.svg',0),
 ('11111111-0000-4000-8000-000000000002','5d000000-0000-4000-8000-000000000001','5d000000-0000-4000-8000-000000000001/11111111-0000-4000-8000-000000000002/lamp.svg',0);
