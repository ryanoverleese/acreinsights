-- Moving a placed to-do updates its workweek_placements row in place
-- (still one block per to-do per week). Only the RPC changes.
create or replace function public.workweek_server_request(
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_headers jsonb := coalesce(nullif(current_setting('request.headers', true), '')::jsonb, '{}'::jsonb);
  v_key text := v_headers ->> 'x-capture-server-key';
  v_week date;
  v_date date;
  v_start numeric;
  v_id uuid;
  v_count integer;
  v_row uuid;
  v_out jsonb;
begin
  if v_key is null or not exists (
    select 1 from private.capture_server_keys k
    where k.active
      and k.key_hash = encode(extensions.digest(convert_to(v_key, 'UTF8'), 'sha256'), 'hex')
  ) then
    raise insufficient_privilege using message = 'Capture server key not accepted';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise invalid_parameter_value using message = 'Payload must be an object';
  end if;

  case p_action
    when 'load' then
      v_week := (p_payload ->> 'week')::date;
      select jsonb_build_object(
        'events', coalesce((select jsonb_agg(jsonb_build_object(
            'calendar', e.calendar, 'date', e.event_date, 'start', e.start_hour,
            'end', e.end_hour, 'title', e.title) order by e.event_date, e.start_hour)
          from public.workweek_events e where e.week_start = v_week), '[]'::jsonb),
        'eventsUpdated', (select max(updated_at) from public.workweek_events where week_start = v_week),
        'placements', coalesce((select jsonb_agg(jsonb_build_object(
            'date', p.block_date, 'start', p.block_start, 'reminder_id', p.reminder_id)
            order by p.created_at)
          from public.workweek_placements p
          where p.block_date >= v_week and p.block_date < v_week + 7), '[]'::jsonb),
        'items', coalesce((select jsonb_agg(jsonb_build_object(
            'id', r.id, 'title', r.title, 'body', r.body, 'category', r.category,
            'kind', r.kind, 'priority', r.priority, 'remind_at', r.remind_at,
            'pinned', r.pinned, 'created_at', r.created_at)
            order by r.priority desc, r.created_at desc)
          from public.reminders r
          where r.deleted_at is null and r.done = false
            and r.kind is distinct from 'memory'), '[]'::jsonb)
      ) into v_out;
      return v_out;

    when 'place' then
      v_date := (p_payload ->> 'date')::date;
      v_start := (p_payload ->> 'start')::numeric;
      v_id := (p_payload ->> 'reminder_id')::uuid;
      if not exists (select 1 from public.reminders r where r.id = v_id and r.deleted_at is null
                     and r.kind is distinct from 'memory') then
        raise invalid_parameter_value using message = 'Invalid reminder';
      end if;
      -- one block per to-do per week: move the existing row in place
      select p.id into v_row
      from public.workweek_placements p
      where p.reminder_id = v_id
        and p.block_date >= v_date - extract(isodow from v_date)::integer + 1
        and p.block_date <  v_date - extract(isodow from v_date)::integer + 8
      order by (p.block_date = v_date and p.block_start = v_start) desc, p.created_at
      limit 1;
      if v_row is null then
        insert into public.workweek_placements (block_date, block_start, reminder_id)
        values (v_date, v_start, v_id);
      else
        delete from public.workweek_placements p
        where p.reminder_id = v_id and p.id <> v_row
          and p.block_date >= v_date - extract(isodow from v_date)::integer + 1
          and p.block_date <  v_date - extract(isodow from v_date)::integer + 8;
        update public.workweek_placements
        set block_date = v_date, block_start = v_start
        where id = v_row and (block_date, block_start) is distinct from (v_date, v_start);
      end if;
      return jsonb_build_object('saved', true);

    when 'unplace' then
      v_date := (p_payload ->> 'date')::date;
      v_start := (p_payload ->> 'start')::numeric;
      v_id := (p_payload ->> 'reminder_id')::uuid;
      delete from public.workweek_placements p
      where p.block_date = v_date and p.block_start = v_start and p.reminder_id = v_id;
      get diagnostics v_count = row_count;
      return jsonb_build_object('deleted', v_count);

    when 'replaceEvents' then
      v_week := (p_payload ->> 'week')::date;
      if jsonb_typeof(p_payload -> 'events') <> 'array' then
        raise invalid_parameter_value using message = 'Events must be an array';
      end if;
      delete from public.workweek_events where week_start = v_week;
      insert into public.workweek_events (week_start, calendar, event_date, start_hour, end_hour, title)
      select v_week, x.calendar, x.date, x.start, x."end", left(x.title, 200)
      from jsonb_to_recordset(p_payload -> 'events') as x(calendar text, date date, start numeric, "end" numeric, title text);
      get diagnostics v_count = row_count;
      return jsonb_build_object('inserted', v_count);

    else
      raise invalid_parameter_value using message = 'Unsupported Work Week action';
  end case;
end;
$$;

revoke all on function public.workweek_server_request(text, jsonb) from public, authenticated;
grant execute on function public.workweek_server_request(text, jsonb) to anon, service_role;

