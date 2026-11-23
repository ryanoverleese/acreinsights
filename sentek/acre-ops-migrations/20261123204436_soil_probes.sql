-- Sentek soil probes (acreinsights.com/soiltemps).
-- Loggers upload .esp files by FTP to the Vultr box; an hourly cron there decodes
-- them and calls public.soil_ingest with its own secret. The public page reads
-- public.soil_public_sites through a Netlify function. Tables are not readable or
-- writable by anon/authenticated directly.

create table public.soil_loggers (
  id bigint generated always as identity primary key,
  logger_name text not null unique check (logger_name ~ '^[A-Za-z0-9_.-]{1,32}$'),
  serial_number text,
  site_name text,
  location_label text,
  latitude numeric(10,7),
  longitude numeric(10,7),
  field_id bigint references public.fields(id) on delete set null,
  clock_utc_offset_minutes integer not null default -360 check (clock_utc_offset_minutes between -720 and 840),
  sort_order integer not null default 100,
  active boolean not null default false,
  public boolean not null default false,
  notes text,
  created_at timestamptz not null default now()
);
comment on table public.soil_loggers is
  'Sentek soil probe loggers. logger_name is the name in the .esp file. Only rows with active AND public show on acreinsights.com/soiltemps, and only site_name and location_label are published (never latitude/longitude/field). clock_utc_offset_minutes is the logger clock offset (-360 = CST, no DST).';

create table public.soil_readings (
  logger_id bigint not null references public.soil_loggers(id) on delete cascade,
  read_at timestamptz not null,
  depth_cm smallint not null check (depth_cm between 0 and 300),
  depth_in numeric(4,1) not null,
  temp_f numeric(5,1),
  water_pct numeric(5,2),
  raw_temp_c real,
  raw_moisture real,
  raw_aux real,
  logger_extra_1 real,
  logger_extra_2 real,
  logger_time timestamp not null,
  source_file text not null,
  ingested_at timestamptz not null default now(),
  primary key (logger_id, read_at, depth_cm)
);
create index soil_readings_logger_time_idx on public.soil_readings (logger_id, read_at desc);
create index soil_readings_source_file_idx on public.soil_readings (source_file);
comment on table public.soil_readings is
  'One row per logger, reading time, and depth. temp_f is from the file''s deg C channel. water_pct uses Sentek''s default calibration %vol = ((SF-0.02852)/0.1957)^(1/0.404) on raw_moisture (uncalibrated for site soil). raw_* keep the decoded file values; raw_aux is an unidentified third channel; logger_extra_2 is likely battery volts.';

alter table public.soil_loggers enable row level security;
alter table public.soil_readings enable row level security;
revoke all on public.soil_loggers from anon, authenticated;
revoke all on public.soil_readings from anon, authenticated;

create table acre_private.soil_ingest_keys (
  id bigint generated always as identity primary key,
  key_sha256 text not null unique check (key_sha256 ~ '^[0-9a-f]{64}$'),
  label text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
alter table acre_private.soil_ingest_keys enable row level security;
revoke all on acre_private.soil_ingest_keys from public, anon, authenticated;

-- Insert-only write path for the Vultr cron. Rejects without a live key; ignores
-- unknown loggers; never updates or deletes existing rows.
create function public.soil_ingest(p_secret text, p_logger text, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_logger public.soil_loggers;
  v_inserted integer;
begin
  if p_secret is null or length(p_secret) < 32 or not exists (
    select 1 from acre_private.soil_ingest_keys k
    where k.revoked_at is null
      and k.key_sha256 = encode(extensions.digest(p_secret, 'sha256'), 'hex')
  ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select * into v_logger from public.soil_loggers l where l.logger_name = p_logger;
  if not found then
    return jsonb_build_object('status', 'unknown_logger');
  end if;

  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'rows must be an array of at most 5000 items' using errcode = '22023';
  end if;

  with src as (
    select * from jsonb_to_recordset(p_rows) as r(
      logger_time timestamp, depth_cm smallint, raw_temp_c real, raw_moisture real,
      raw_aux real, extra_1 real, extra_2 real, source_file text)
    where r.logger_time is not null and r.depth_cm is not null and r.source_file is not null
  ), ins as (
    insert into public.soil_readings (
      logger_id, read_at, depth_cm, depth_in, temp_f, water_pct,
      raw_temp_c, raw_moisture, raw_aux, logger_extra_1, logger_extra_2, logger_time, source_file)
    select
      v_logger.id,
      (s.logger_time - make_interval(mins => v_logger.clock_utc_offset_minutes)) at time zone 'UTC',
      s.depth_cm,
      round(s.depth_cm / 2.54, 1),
      case when s.raw_temp_c between -40 and 70 then round((s.raw_temp_c * 9 / 5 + 32)::numeric, 1) end,
      case
        when s.raw_moisture is null or s.raw_moisture < 0 or s.raw_moisture > 1.2 then null
        when s.raw_moisture <= 0.02852 then 0
        else round(power((s.raw_moisture - 0.02852) / 0.1957, 1 / 0.404)::numeric, 2)
      end,
      s.raw_temp_c, s.raw_moisture, s.raw_aux, s.extra_1, s.extra_2, s.logger_time, left(s.source_file, 120)
    from src s
    on conflict do nothing
    returning 1
  )
  select count(*) into v_inserted from ins;

  return jsonb_build_object('status', 'ok', 'received', jsonb_array_length(p_rows), 'inserted', v_inserted);
end;
$$;

-- Display payload. p_include_hidden is only reachable by the database owner
-- (never granted to API roles); the public wrapper always passes false.
create function acre_private.soil_sites_payload(p_include_hidden boolean, p_days integer)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
with sites as (
  select l.id, l.site_name, l.location_label, l.sort_order,
         (select max(r.read_at) from public.soil_readings r where r.logger_id = l.id) as last_read_at
  from public.soil_loggers l
  where p_include_hidden or (l.active and l.public)
),
surface as (
  select r.logger_id, r.read_at, avg(r.temp_f) as t
  from public.soil_readings r
  join sites s on s.id = r.logger_id
  where r.depth_cm in (5, 15) and r.temp_f is not null and r.read_at > s.last_read_at - interval '9 days'
  group by r.logger_id, r.read_at
  having count(*) = 2
),
daily as (
  select logger_id, (read_at at time zone 'America/Chicago')::date as d,
         avg(t) as avg_f, max(t) as high_f, min(t) as low_f, count(*) as n
  from surface
  group by logger_id, (read_at at time zone 'America/Chicago')::date
),
pick as (
  select distinct on (logger_id) logger_id, d, avg_f, high_f, low_f, n
  from daily
  where d < (now() at time zone 'America/Chicago')::date
  order by logger_id, d desc
)
select jsonb_build_object(
  'generated_at', now(),
  'sites', coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'name', coalesce(nullif(s.site_name, ''), 'Unnamed site'),
    'location', s.location_label,
    'last_read_at', s.last_read_at,
    'latest', (
      select jsonb_agg(jsonb_build_object('depth_in', round(r.depth_in)::int, 'temp_f', r.temp_f, 'water_pct', r.water_pct) order by r.depth_cm)
      from public.soil_readings r where r.logger_id = s.id and r.read_at = s.last_read_at),
    'surface_day', (
      select jsonb_build_object('date', p.d, 'avg_f', round(p.avg_f, 1), 'high_f', round(p.high_f, 1),
               'low_f', round(p.low_f, 1), 'readings', p.n,
               'avg_7day_f', (select round(avg(d2.avg_f), 1) from daily d2
                              where d2.logger_id = p.logger_id and d2.d > p.d - 7 and d2.d <= p.d))
      from pick p where p.logger_id = s.id),
    'water_series', jsonb_build_object(
      'depths_in', (
        select jsonb_agg(x.di order by x.dc) from (
          select distinct r.depth_cm as dc, round(r.depth_in)::int as di
          from public.soil_readings r
          where r.logger_id = s.id and r.read_at > s.last_read_at - make_interval(days => p_days)) x),
      'points', (
        select jsonb_agg(jsonb_build_object('t', q.read_at, 'w', q.w) order by q.read_at) from (
          select r.read_at, jsonb_agg(r.water_pct order by r.depth_cm) as w
          from public.soil_readings r
          where r.logger_id = s.id and r.read_at > s.last_read_at - make_interval(days => p_days)
          group by r.read_at) q))
  ) order by s.sort_order, s.id) filter (where s.last_read_at is not null), '[]'::jsonb)
)
from sites s;
$$;

create function public.soil_public_sites(p_days integer default 7)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select acre_private.soil_sites_payload(false, least(greatest(coalesce(p_days, 7), 1), 14));
$$;

revoke all on function public.soil_ingest(text, text, jsonb) from public, anon, authenticated;
revoke all on function acre_private.soil_sites_payload(boolean, integer) from public, anon, authenticated;
revoke all on function public.soil_public_sites(integer) from public, anon, authenticated;
grant execute on function public.soil_ingest(text, text, jsonb) to anon;
grant execute on function public.soil_public_sites(integer) to anon;

insert into public.soil_loggers (logger_name, serial_number, notes, active, public)
values ('ai_shop_test', 'DD081320',
        'Sentek Compact DTU. Shop test (probe in air) until install; site name and public location label TBD by Ryan.',
        false, false);
