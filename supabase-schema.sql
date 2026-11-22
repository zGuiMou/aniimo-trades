create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null
    check (username ~ '^[a-zA-Z0-9_]{3,24}$'),
  created_at timestamptz not null default now()
);

create unique index if not exists profiles_username_lower_idx
  on public.profiles (lower(username));

alter table public.profiles
  add column if not exists collection_updated_at timestamptz;

create table if not exists public.aniimo_copies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  aniimo_key text not null,
  aniimo_path text not null,
  display_name text not null,
  background_mode text not null default 'normal'
    check (background_mode in ('normal', 'umbrais')),
  pv integer not null default 0 check (pv between 0 and 20),
  atk integer not null default 0 check (atk between 0 and 20),
  def_f integer not null default 0 check (def_f between 0 and 20),
  regen integer not null default 0 check (regen between 0 and 20),
  def_m integer not null default 0 check (def_m between 0 and 20),
  rupture integer not null default 0 check (rupture between 0 and 20),
  created_at timestamptz not null default now()
);

create index if not exists aniimo_copies_user_idx
  on public.aniimo_copies (user_id, created_at);

alter table public.aniimo_copies
  add column if not exists updated_at timestamptz not null default now();

update public.aniimo_copies
set updated_at = created_at
where updated_at is null;

alter table public.profiles enable row level security;
alter table public.aniimo_copies enable row level security;

drop policy if exists "Public profiles are readable" on public.profiles;
create policy "Public profiles are readable"
  on public.profiles for select
  using (true);

drop policy if exists "Users can update their profile" on public.profiles;
create policy "Users can update their profile"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

drop policy if exists "Collections are publicly readable" on public.aniimo_copies;
create policy "Collections are publicly readable"
  on public.aniimo_copies for select
  using (true);

drop policy if exists "Users can add to their collection" on public.aniimo_copies;
create policy "Users can add to their collection"
  on public.aniimo_copies for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their collection" on public.aniimo_copies;
create policy "Users can update their collection"
  on public.aniimo_copies for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can remove from their collection" on public.aniimo_copies;
create policy "Users can remove from their collection"
  on public.aniimo_copies for delete
  using (auth.uid() = user_id);

grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.aniimo_copies to authenticated;
grant select on public.profiles, public.aniimo_copies to anon;

create or replace function public.set_aniimo_copy_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists on_aniimo_copy_updated_at on public.aniimo_copies;
create trigger on_aniimo_copy_updated_at
  before update on public.aniimo_copies
  for each row execute procedure public.set_aniimo_copy_updated_at();

create or replace function public.touch_profile_collection_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.profiles
  set collection_updated_at = now()
  where id = coalesce(new.user_id, old.user_id);
  return coalesce(new, old);
end;
$$;

drop trigger if exists on_aniimo_copy_collection_changed on public.aniimo_copies;
create trigger on_aniimo_copy_collection_changed
  after insert or update or delete on public.aniimo_copies
  for each row execute procedure public.touch_profile_collection_updated_at();

update public.profiles profile
set collection_updated_at = latest.changed_at
from (
  select user_id, max(greatest(created_at, updated_at)) as changed_at
  from public.aniimo_copies
  group by user_id
) latest
where profile.id = latest.user_id
  and profile.collection_updated_at is null;

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (new.id, lower(trim(new.raw_user_meta_data ->> 'username')));
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row execute procedure public.create_profile_for_new_user();
