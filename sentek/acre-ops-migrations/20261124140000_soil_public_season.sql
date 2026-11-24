-- Daily season aggregates for acreinsights.com/soiltemps.
-- NOT APPLIED. Tables are not readable by anon, so the Netlify function cannot
-- build this from PostgREST directly. Apply in the Acre Ops project (junawlttpyztjlnbmvcb)
-- after Ryan's OK. Does not change soil_ingest, soil_loggers, or the existing
-- soil_public_sites / soil_sites_payload functions.

create function public.soil_public_season(p_days integer default 400)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
with span as (
  select least(greatest(coalesce(p_days, 400), 1), 400) as days
),
sites as (
  select l.id, l.site_name, l.sort_order,
         (select max(r.read_at) from public.soil_readings r where r.logger_id = l.id) as last_read_at
  from public.soil_loggers l
  where l.active and l.public
),
daily as (
  select
    r.logger_id,
    (r.read_at at time zone 'America/Chicago')::date as d,
    min(r.depth_cm) as depth_cm,
    round(r.depth_cm / 2.54)::int as depth_in,
    avg(r.water_pct) as water_avg,
    max(r.water_pct) as water_high,
    min(r.water_pct) as water_low,
    avg(r.temp_f) as temp_avg,
    max(r.temp_f) as temp_high,
    min(r.temp_f) as temp_low
  from public.soil_readings r
  join sites s on s.id = r.logger_id
  cross join span
  where s.last_read_at is not null
    and r.read_at > s.last_read_at - make_interval(days => span.days)
  group by r.logger_id, (r.read_at at time zone 'America/Chicago')::date, round(r.depth_cm / 2.54)::int
),
depths as (
  select distinct logger_id, depth_cm, depth_in from daily
),
days as (
  select distinct logger_id, d from daily
),
grid as (
  select
    y.logger_id, y.d, dep.depth_cm, dep.depth_in,
    d.water_avg, d.water_high, d.water_low,
    d.temp_avg, d.temp_high, d.temp_low
  from days y
  join depths dep on dep.logger_id = y.logger_id
  left join daily d
    on d.logger_id = y.logger_id and d.d = y.d and d.depth_in = dep.depth_in
)
select jsonb_build_object(
  'sites', coalesce(jsonb_agg(jsonb_build_object(
    'name', coalesce(nullif(s.site_name, ''), 'Unnamed site'),
    'depths_in', (
      select jsonb_agg(x.depth_in order by x.depth_cm)
      from (select distinct g.depth_cm, g.depth_in from grid g where g.logger_id = s.id) x
    ),
    'days', (
      select jsonb_agg(jsonb_build_object(
        'date', q.d,
        'w_avg', q.w_avg, 'w_high', q.w_high, 'w_low', q.w_low,
        't_avg', q.t_avg, 't_high', q.t_high, 't_low', q.t_low
      ) order by q.d)
      from (
        select
          g.d,
          jsonb_agg(round(g.water_avg, 2) order by g.depth_cm) as w_avg,
          jsonb_agg(round(g.water_high, 2) order by g.depth_cm) as w_high,
          jsonb_agg(round(g.water_low, 2) order by g.depth_cm) as w_low,
          jsonb_agg(round(g.temp_avg, 1) order by g.depth_cm) as t_avg,
          jsonb_agg(round(g.temp_high, 1) order by g.depth_cm) as t_high,
          jsonb_agg(round(g.temp_low, 1) order by g.depth_cm) as t_low
        from grid g
        where g.logger_id = s.id
        group by g.d
      ) q
    )
  ) order by s.sort_order, s.id) filter (where s.last_read_at is not null), '[]'::jsonb)
)
from sites s;
$$;

revoke all on function public.soil_public_season(integer) from public, anon, authenticated;
grant execute on function public.soil_public_season(integer) to anon;

comment on function public.soil_public_season(integer) is
  'Read-only daily water and temperature aggregates (avg/high/low by depth, America/Chicago dates) for active AND public soil loggers. Used by /api/soil for the season chart. Caps lookback at 400 days. Never returns coordinates, logger names, or raw channels.';
