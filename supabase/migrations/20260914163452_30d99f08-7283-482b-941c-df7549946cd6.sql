create table public.conversation_log (
  id uuid primary key default gen_random_uuid(),
  role public.app_role not null,
  text text not null,
  source text not null check (source in ('original','translated')),
  created_at timestamptz not null default now()
);

grant select, insert, delete on public.conversation_log to authenticated;
grant all on public.conversation_log to service_role;

alter table public.conversation_log enable row level security;

create policy "Arzt und Patient lesen Log" on public.conversation_log
  for select to authenticated
  using (public.has_role(auth.uid(),'arzt') or public.has_role(auth.uid(),'patient'));

create policy "Arzt und Patient schreiben Log" on public.conversation_log
  for insert to authenticated
  with check (public.has_role(auth.uid(),'arzt') or public.has_role(auth.uid(),'patient'));

create policy "Arzt und Patient loeschen Log" on public.conversation_log
  for delete to authenticated
  using (public.has_role(auth.uid(),'arzt') or public.has_role(auth.uid(),'patient'));