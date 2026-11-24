-- Add t_f (temp °F by depth) to each public soil series point, alongside w.
-- Does not change soil_ingest, soil_loggers, or soil_readings.
-- public.soil_public_sites is unchanged and still returns this payload.

create or replace function acre_private.soil_sites_payload(p_include_hidden boolean, p_days integer)
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
      select jsonb_agg(jsonb_build_object('depth_in', round(r.depth_cm / 2.54)::int, 'temp_f', r.temp_f, 'water_pct', r.water_pct) order by r.depth_cm)
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
          select distinct r.depth_cm as dc, round(r.depth_cm / 2.54)::int as di
          from public.soil_readings r
          where r.logger_id = s.id and r.read_at > s.last_read_at - make_interval(days => p_days)) x),
      'points', (
        select jsonb_agg(jsonb_build_object('t', q.read_at, 'w', q.w, 't_f', q.t_f) order by q.read_at) from (
          select r.read_at,
                 jsonb_agg(r.water_pct order by r.depth_cm) as w,
                 jsonb_agg(r.temp_f order by r.depth_cm) as t_f
          from public.soil_readings r
          where r.logger_id = s.id and r.read_at > s.last_read_at - make_interval(days => p_days)
          group by r.read_at) q))
  ) order by s.sort_order, s.id) filter (where s.last_read_at is not null), '[]'::jsonb)
)
from sites s;
$$;
