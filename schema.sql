-- E2EE sync blobs for Endustrie Tracker (applied to Supabase project "L-Compass"
-- as migration `endustrie_tracker_e2ee_sync`).
-- Rows hold ONLY client-side-encrypted ciphertext under a random capability id.
create table if not exists public.endustrie_sync (
  sync_id text primary key check (char_length(sync_id) between 32 and 128),
  salt text not null,
  wrapped_key text not null,
  ciphertext text not null,
  updated_at timestamptz not null default now()
);

alter table public.endustrie_sync enable row level security;

-- Capability model: a request can only touch the row whose sync_id it presents
-- in the X-Sync-Id header (128-bit random, generated client-side).
create policy endustrie_sync_select on public.endustrie_sync for select
  using (sync_id = ((current_setting('request.headers', true))::json ->> 'x-sync-id'));

create policy endustrie_sync_insert on public.endustrie_sync for insert
  with check (sync_id = ((current_setting('request.headers', true))::json ->> 'x-sync-id'));

create policy endustrie_sync_update on public.endustrie_sync for update
  using (sync_id = ((current_setting('request.headers', true))::json ->> 'x-sync-id'))
  with check (sync_id = ((current_setting('request.headers', true))::json ->> 'x-sync-id'));

create policy endustrie_sync_delete on public.endustrie_sync for delete
  using (sync_id = ((current_setting('request.headers', true))::json ->> 'x-sync-id'));

-- v2: versioned state blobs + content-addressed encrypted attachments
-- (migration `endustrie_tracker_sync_v2_versions_attachments`)
create table if not exists public.endustrie_sync_v2 (
  sync_id text not null check (char_length(sync_id) between 32 and 128),
  ver bigint not null,
  salt text not null,
  wrapped_key text not null,
  ciphertext text not null,
  created_at timestamptz not null default now(),
  primary key (sync_id, ver)
);
create table if not exists public.endustrie_sync_att (
  sync_id text not null check (char_length(sync_id) between 32 and 128),
  hash text not null,
  ciphertext text not null,
  created_at timestamptz not null default now(),
  primary key (sync_id, hash)
);
alter table public.endustrie_sync_v2 enable row level security;
alter table public.endustrie_sync_att enable row level security;
create policy sync_v2_select on public.endustrie_sync_v2 for select
  using (sync_id = ((current_setting('request.headers', true))::json ->> 'x-sync-id'));
create policy sync_v2_insert on public.endustrie_sync_v2 for insert
  with check (sync_id = ((current_setting('request.headers', true))::json ->> 'x-sync-id'));
create policy sync_v2_delete on public.endustrie_sync_v2 for delete
  using (sync_id = ((current_setting('request.headers', true))::json ->> 'x-sync-id'));
create policy sync_att_select on public.endustrie_sync_att for select
  using (sync_id = ((current_setting('request.headers', true))::json ->> 'x-sync-id'));
create policy sync_att_insert on public.endustrie_sync_att for insert
  with check (sync_id = ((current_setting('request.headers', true))::json ->> 'x-sync-id'));
create policy sync_att_delete on public.endustrie_sync_att for delete
  using (sync_id = ((current_setting('request.headers', true))::json ->> 'x-sync-id'));
