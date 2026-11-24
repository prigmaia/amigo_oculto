-- Rode no SQL Editor do Supabase. Antes: Authentication > Providers > habilitar "Anonymous sign-ins".
-- Este arquivo cria o esquema inicial; não rode tudo novamente em um projeto já configurado.
-- Para projetos existentes, execute somente a migração específica indicada.
create table rooms(
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  title text not null,
  admin_id uuid not null default auth.uid(),
  min_value numeric, max_value numeric, event_date date, location text,
  drawn boolean not null default false,
  created_at timestamptz default now());
create table participants(
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms on delete cascade,
  user_id uuid not null default auth.uid(),
  name text not null, age int, likes text, wishes text, photo_url text, product_links text,
  email text not null,
  unique(room_id, user_id));
-- Migração para projetos que já criaram a tabela participants.
alter table participants add column if not exists product_links text;
-- Quem foi sorteado para quem: ninguém lê pelo app, só a função "draw" (service role).
create table assignments(
  room_id uuid references rooms on delete cascade,
  giver uuid references participants on delete cascade,
  receiver uuid references participants on delete cascade,
  email_sent_at timestamptz,
  primary key(room_id, giver));
-- Migração para instalações que já criaram a tabela assignments.
alter table assignments add column if not exists email_sent_at timestamptz;
alter table rooms enable row level security;
alter table participants enable row level security;
alter table assignments enable row level security;

-- e-mails ficam invisíveis para o app (só a função de sorteio lê)
revoke select on participants from anon, authenticated;
grant select (id,room_id,user_id,name,age,likes,wishes,photo_url) on participants to authenticated;
grant select (product_links) on participants to authenticated;

create function is_member(r uuid) returns boolean language sql security definer set search_path=public as $$
  select exists(select 1 from participants where room_id=r and user_id=auth.uid())
      or exists(select 1 from rooms where id=r and admin_id=auth.uid()) $$;

create or replace function get_room_participants(invite_code text)
returns table(id uuid,user_id uuid,name text,age int,likes text,wishes text,photo_url text)
language sql stable security definer set search_path=public as $$
  select p.id,p.user_id,p.name,p.age,p.likes,p.wishes,p.photo_url
  from participants p join rooms r on r.id=p.room_id
  where r.code=invite_code
  order by p.name $$;
revoke all on function get_room_participants(text) from public, anon;
grant execute on function get_room_participants(text) to authenticated;

create policy rooms_read on rooms for select to authenticated using (true);
create policy rooms_new on rooms for insert to authenticated with check (admin_id=auth.uid());
create policy rooms_edit on rooms for update to authenticated using (admin_id=auth.uid() and not drawn);
create policy part_read on participants for select to authenticated using (is_member(room_id));
create policy part_new on participants for insert to authenticated
  with check (user_id=auth.uid() and not exists(select 1 from rooms where id=room_id and drawn));
create policy part_edit on participants for update to authenticated using (user_id=auth.uid());
create policy part_del on participants for delete to authenticated using (
  user_id=auth.uid() or exists(select 1 from rooms where id=room_id and admin_id=auth.uid() and not drawn));

insert into storage.buckets(id,name,public) values('photos','photos',true) on conflict do nothing;
create policy photos_read_for_upsert on storage.objects for select to authenticated using (bucket_id='photos');
create policy photos_up on storage.objects for insert to authenticated with check (bucket_id='photos');
create policy photos_upd on storage.objects for update to authenticated using (bucket_id='photos') with check (bucket_id='photos');
