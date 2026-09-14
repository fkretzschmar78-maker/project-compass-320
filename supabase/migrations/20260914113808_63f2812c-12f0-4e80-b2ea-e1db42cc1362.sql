create type public.app_role as enum ('arzt', 'patient', 'spectator');

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;

alter table public.user_roles enable row level security;

create table public.role_whitelist (
  email text primary key,
  role public.app_role not null,
  created_at timestamptz not null default now()
);

grant all on public.role_whitelist to service_role;

alter table public.role_whitelist enable row level security;

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and role = _role
  )
$$;

create policy "Nutzer sehen eigene Rollen"
  on public.user_roles for select to authenticated
  using (auth.uid() = user_id);

create policy "Aerzte sehen alle Rollen"
  on public.user_roles for select to authenticated
  using (public.has_role(auth.uid(), 'arzt'));

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  _role public.app_role;
begin
  select w.role into _role
  from public.role_whitelist w
  where lower(w.email) = lower(new.email);

  insert into public.user_roles (user_id, role)
  values (new.id, coalesce(_role, 'spectator'))
  on conflict (user_id, role) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();