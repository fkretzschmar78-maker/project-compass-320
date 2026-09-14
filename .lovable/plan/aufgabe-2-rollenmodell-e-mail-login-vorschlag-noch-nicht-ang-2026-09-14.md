# Aufgabe 2 — Rollenmodell + E-Mail-Login (Vorschlag, noch nicht angewendet)

## Bestandsaufnahme

- Kein Backend verbunden (`src/integrations/supabase/*` existiert nicht, kein `supabase/`-Ordner).
- Routen: nur `src/routes/__root.tsx` und `src/routes/index.tsx` (Platzhalter-Startseite).
- `src/start.ts` enthält bereits `errorMiddleware` + `csrfMiddleware` als `requestMiddleware`; `functionMiddleware` fehlt noch.
- Kein Auth-Code, keine Guards, keine Tabellen.

## Was gemacht wird (nach Freigabe)

1. Lovable Cloud aktivieren (legt `src/integrations/supabase/*`, Env-Variablen und den Auth-Gate `src/routes/_authenticated/route.tsx` an).
2. E-Mail/Passwort-Login aktivieren.
3. Eine Migration mit Enum, `user_roles`, `role_whitelist`, `has_role()`, Trigger und Policies.
4. Auth-Seite `/auth`, geschützter Bereich `/dashboard`, Rollen-Hook, Bearer-Middleware in `src/start.ts`.

Rolle ist niemals vom Nutzer wählbar: sie wird ausschließlich serverseitig beim Signup/Login aus der Whitelist-Tabelle abgeleitet.

---

## SQL-Migration (vollständig)

```sql
-- 1. Enum
create type public.app_role as enum ('arzt', 'patient', 'spectator');

-- 2. Rollentabelle
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

-- 3. Whitelist: E-Mail -> feste Rolle (bewusst leer, nur Struktur)
create table public.role_whitelist (
  email text primary key,
  role public.app_role not null,
  created_at timestamptz not null default now()
);

grant all on public.role_whitelist to service_role;
-- kein Zugriff für anon/authenticated: nur serverseitig lesbar

alter table public.role_whitelist enable row level security;

-- 4. Rollenprüfung (SECURITY DEFINER, verhindert RLS-Rekursion)
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

-- 5. Policies
create policy "Nutzer sehen eigene Rollen"
  on public.user_roles for select to authenticated
  using (auth.uid() = user_id);

create policy "Ärzte sehen alle Rollen"
  on public.user_roles for select to authenticated
  using (public.has_role(auth.uid(), 'arzt'));

-- kein INSERT/UPDATE/DELETE für Nutzer: Rollenvergabe nur per Trigger/service_role
-- role_whitelist: keine Policy => für anon/authenticated komplett gesperrt

-- 6. Rollenzuweisung beim Signup, ausschließlich aus der Whitelist
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
```

Nutzer ohne Whitelist-Eintrag bekommen `spectator` — die schwächste Rolle. Falls stattdessen gar keine Rolle vergeben werden soll, sag Bescheid, dann fällt das `coalesce` weg.

---

## Dateien

**Neu: `src/lib/roles.functions.ts`**
Server-Funktion `getMyRole` mit `requireSupabaseAuth`. Liest die Rolle des eingeloggten Nutzers aus `user_roles`. Zusätzlich `syncMyRole`: gleicht die E-Mail des Nutzers erneut gegen die Whitelist ab (für Fälle, in denen die Whitelist erst nach der Registrierung gepflegt wurde) und schreibt die Rolle mit Admin-Rechten — die Rolle kommt dabei ausschließlich aus der Tabelle, nie aus Client-Eingaben.

**Neu: `src/hooks/use-role.ts`**
React-Query-Hook auf `getMyRole`.

**Neu: `src/routes/auth.tsx`**
Öffentliche Seite `/auth`: E-Mail + Passwort, Tabs Anmelden/Registrieren, `emailRedirectTo: window.location.origin`, Hinweis auf Bestätigungsmail. Keine Rollenauswahl im Formular.

**Neu: `src/routes/_authenticated/dashboard.tsx`**
Geschützte Seite: zeigt E-Mail und zugewiesene Rolle, Abmelden-Button.

**Geändert: `src/routes/index.tsx`**
Platzhalter ersetzt durch Startseite mit sessionabhängigem Button (Anmelden / Zum Dashboard) und `head()`-Metadaten.

**Geändert: `src/routes/__root.tsx`**
Einmaliger `onAuthStateChange`-Listener (gefiltert auf SIGNED_IN/SIGNED_OUT/USER_UPDATED) → `router.invalidate()`, plus `<Toaster />`.

**Geändert: `src/start.ts`**
`functionMiddleware: [attachSupabaseAuth]` ergänzt, bestehende `requestMiddleware` unverändert.

**Automatisch erzeugt** beim Aktivieren von Lovable Cloud: `src/integrations/supabase/client.ts`, `client.server.ts`, `auth-middleware.ts`, `auth-attacher.ts`, `types.ts`, `src/routes/_authenticated/route.tsx`.

---

## Offene Punkte

- Whitelist bleibt leer. Befüllen später per SQL-Insert, sobald echte Adressen vorliegen.
- E-Mail-Bestätigung bleibt an (Standard). Soll die Registrierung sofort einloggen, muss Auto-Confirm aktiviert werden — sag Bescheid.
