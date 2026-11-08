-- SolarIA: esquema para Supabase (pegar completo en SQL Editor y ejecutar)

create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name        text not null,
  location    text,
  start_date  date,
  use         text default 'Otro',
  use_detail  text,
  inverter    text,
  description text,
  created_at  timestamptz default now()
);

create table public.panels (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  brand text, model text,
  qty int not null check (qty > 0),
  wp  numeric not null check (wp > 0),
  type text, eff numeric default 0,
  created_at timestamptz default now()
);

create table public.generation (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  date date not null,
  kwh numeric not null check (kwh >= 0),
  pk  numeric default 0,
  irr numeric default 0,
  unique (project_id, date)
);

create table public.events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  date date not null,
  type text not null check (type in ('Falla','Mantenimiento')),
  description text
);

-- Seguridad: cada usuario solo ve y modifica sus propias filas
alter table public.projects   enable row level security;
alter table public.panels     enable row level security;
alter table public.generation enable row level security;
alter table public.events     enable row level security;

create policy "own rows" on public.projects   for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own rows" on public.panels     for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own rows" on public.generation for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own rows" on public.events     for all to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create index on public.panels(project_id);
create index on public.generation(project_id, date);
create index on public.events(project_id);