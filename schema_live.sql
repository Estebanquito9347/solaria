-- SolarIA: tablas y endpoint para dispositivos IoT (ejecutar despues de schema.sql)

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.devices (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  project_id  uuid not null references public.projects(id) on delete cascade,
  name        text not null default 'Dispositivo' check (char_length(name) between 1 and 80),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  last_seen   timestamptz
);

create table if not exists public.device_secrets (
  device_id  uuid primary key references public.devices(id) on delete cascade,
  key_hash   text not null unique,
  created_at timestamptz not null default now()
);

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'devices' and column_name = 'key'
  ) then
    execute $migration$
      insert into public.device_secrets(device_id, key_hash)
      select id, encode(extensions.digest(convert_to("key", 'UTF8'), 'sha256'), 'hex')
      from public.devices
      on conflict (device_id) do nothing
    $migration$;
  end if;
end
$$;

alter table public.devices drop column if exists key;

create table if not exists public.readings (
  id          bigint generated always as identity primary key,
  device_id   uuid not null references public.devices(id) on delete cascade,
  project_id  uuid not null references public.projects(id) on delete cascade,
  ts          timestamptz not null default now(),
  power_kw    numeric not null check (power_kw >= 0 and power_kw <= 100000),
  energy_kwh  numeric check (energy_kwh is null or (energy_kwh >= 0 and energy_kwh <= 1000000000)),
  irr_wm2     numeric check (irr_wm2 is null or (irr_wm2 >= 0 and irr_wm2 <= 2000))
);

create index if not exists readings_project_ts_idx
  on public.readings(project_id, ts desc);
create index if not exists readings_device_ts_idx
  on public.readings(device_id, ts desc);

alter table public.devices enable row level security;
alter table public.device_secrets enable row level security;
alter table public.readings enable row level security;

drop policy if exists "Project owners can read devices" on public.devices;
create policy "Project owners can read devices" on public.devices
  for select to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.projects p
      where p.id = devices.project_id and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "Project owners can create devices" on public.devices;

drop policy if exists "Project owners can delete devices" on public.devices;
create policy "Project owners can delete devices" on public.devices
  for delete to authenticated
  using (
    user_id = (select auth.uid())
    and exists (
      select 1 from public.projects p
      where p.id = devices.project_id and p.user_id = (select auth.uid())
    )
  );

drop policy if exists "Project owners can read device readings" on public.readings;
create policy "Project owners can read device readings" on public.readings
  for select to authenticated
  using (
    exists (
      select 1 from public.devices d
      where d.id = readings.device_id
        and d.project_id = readings.project_id
        and d.user_id = (select auth.uid())
    )
  );

grant usage on schema public to anon, authenticated;
revoke all on public.devices from anon, authenticated;
grant select, delete on public.devices to authenticated;
revoke all on public.device_secrets from anon, authenticated;
revoke all on public.readings from anon, authenticated;
grant select on public.readings to authenticated;

create or replace function public.create_device(
  p_project_id uuid,
  p_name text default 'Dispositivo'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device_id uuid;
  v_name text := coalesce(nullif(btrim(p_name), ''), 'Dispositivo');
  v_device_key text;
begin
  if auth.uid() is null then
    raise exception using errcode = '28000', message = 'Authentication required';
  end if;

  if char_length(v_name) > 80 then
    raise exception using errcode = '22023', message = 'Device name is too long';
  end if;

  if not exists (
    select 1 from public.projects p
    where p.id = p_project_id and p.user_id = auth.uid()
  ) then
    raise exception using errcode = '42501', message = 'Project not found or not owned by user';
  end if;

  v_device_key := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  insert into public.devices(user_id, project_id, name)
  values (auth.uid(), p_project_id, v_name)
  returning id into v_device_id;

  insert into public.device_secrets(device_id, key_hash)
  values (
    v_device_id,
    encode(extensions.digest(convert_to(v_device_key, 'UTF8'), 'sha256'), 'hex')
  );

  return jsonb_build_object('id', v_device_id, 'name', v_name, 'device_key', v_device_key);
end;
$$;

create or replace function public.ingest_reading(
  p_device_key text,
  p_power_kw numeric,
  p_energy_kwh numeric default null,
  p_irr_wm2 numeric default null,
  p_ts timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_device public.devices%rowtype;
  v_reading_id bigint;
  v_ts timestamptz := coalesce(p_ts, now());
begin
  if p_device_key is null or p_device_key !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Invalid device key';
  end if;

  if p_power_kw is null or p_power_kw < 0 or p_power_kw > 100000 then
    raise exception using errcode = '22023', message = 'power_kw is outside the accepted range';
  end if;

  if p_energy_kwh is not null and (p_energy_kwh < 0 or p_energy_kwh > 1000000000) then
    raise exception using errcode = '22023', message = 'energy_kwh is outside the accepted range';
  end if;

  if p_irr_wm2 is not null and (p_irr_wm2 < 0 or p_irr_wm2 > 2000) then
    raise exception using errcode = '22023', message = 'irr_wm2 is outside the accepted range';
  end if;

  if v_ts > now() + interval '5 minutes' then
    raise exception using errcode = '22023', message = 'Reading timestamp is too far in the future';
  end if;

  select d.* into v_device
  from public.devices d
  join public.device_secrets s on s.device_id = d.id
  where s.key_hash = encode(extensions.digest(convert_to(p_device_key, 'UTF8'), 'sha256'), 'hex')
    and d.is_active;

  if not found then
    raise exception using errcode = '28000', message = 'Unknown or inactive device';
  end if;

  insert into public.readings (device_id, project_id, ts, power_kw, energy_kwh, irr_wm2)
  values (v_device.id, v_device.project_id, v_ts, p_power_kw, p_energy_kwh, p_irr_wm2)
  returning id into v_reading_id;

  update public.devices set last_seen = now() where id = v_device.id;

  return jsonb_build_object('ok', true, 'reading_id', v_reading_id);
end;
$$;

revoke all on function public.create_device(uuid, text) from public;
grant execute on function public.create_device(uuid, text) to authenticated;
revoke all on function public.ingest_reading(text, numeric, numeric, numeric, timestamptz) from public;
grant execute on function public.ingest_reading(text, numeric, numeric, numeric, timestamptz) to anon, authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'readings'
     ) then
    execute 'alter publication supabase_realtime add table public.readings';
  end if;
end
$$;
