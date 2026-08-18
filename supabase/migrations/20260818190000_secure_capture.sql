-- Capture stays login-free for Ryan. The browser and morning organizer reach
-- these tables only through this server-key-checked RPC.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.capture_server_keys (
  name text primary key,
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table private.capture_server_keys enable row level security;
revoke all on table private.capture_server_keys from public, anon, authenticated;

insert into private.capture_server_keys (name, key_hash)
values ('primary', '9b9ce8f356127c56f150d1dc4f526e90df53de0955562faa3da50771899d6100')
on conflict (name) do update set key_hash = excluded.key_hash, active = true;

create or replace function public.capture_server_request(
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
  v_items jsonb;
  v_run jsonb;
  v_changes jsonb;
  v_row jsonb;
  v_change jsonb := coalesce(p_payload -> 'changes', '{}'::jsonb);
  v_id uuid;
  v_batch uuid;
  v_count integer;
  v_start timestamptz;
  v_end timestamptz;
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
      select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]'::jsonb)
      into v_items from (
        select id, created_at, body, done, done_at, category, kind, title,
               summary, priority, pinned, remind_at, tags, surfaced_reason,
               surfaced_on, locked_fields
        from public.reminders where deleted_at is null
      ) r;
      select to_jsonb(r) into v_run from (
        select * from public.agent_runs order by ran_at desc limit 1
      ) r;
      v_batch := nullif(v_run ->> 'batch_id', '')::uuid;
      select coalesce(jsonb_agg(to_jsonb(c) order by c.changed_at desc), '[]'::jsonb)
      into v_changes from (
        select * from public.agent_changes
        where reverted = false
          and ((needs_ok = true and confirmed is null)
               or (v_batch is not null and batch_id = v_batch))
      ) c;
      return jsonb_build_object('items', v_items, 'run', v_run, 'changes', v_changes);

    when 'createReminder' then
      if nullif(btrim(p_payload ->> 'body'), '') is null
         or char_length(p_payload ->> 'body') > 50000 then
        raise invalid_parameter_value using message = 'Invalid reminder';
      end if;
      insert into public.reminders (body) values (rtrim(p_payload ->> 'body'))
      returning to_jsonb(reminders) into v_row;
      return v_row;

    when 'updateReminder' then
      v_id := (p_payload ->> 'id')::uuid;
      if jsonb_typeof(v_change) <> 'object' or v_change = '{}'::jsonb then
        raise invalid_parameter_value using message = 'Changes are required';
      end if;
      if exists (
        select 1 from jsonb_object_keys(v_change) as keys(key) where key not in (
          'body', 'done', 'done_at', 'category', 'kind', 'title', 'summary',
          'priority', 'pinned', 'remind_at', 'tags', 'entities', 'related',
          'surfaced_reason', 'surfaced_on', 'agent_reviewed_at',
          'locked_fields', 'deleted_at'
        )
      ) then
        raise invalid_parameter_value using message = 'Unsupported reminder change';
      end if;
      if v_change ? 'body' and (
        nullif(btrim(v_change ->> 'body'), '') is null
        or char_length(v_change ->> 'body') > 50000
      ) then
        raise invalid_parameter_value using message = 'Invalid body';
      end if;
      update public.reminders r set
        body = case when v_change ? 'body' then v_change ->> 'body' else r.body end,
        done = case when v_change ? 'done' then (v_change ->> 'done')::boolean else r.done end,
        done_at = case when v_change ? 'done_at' then (v_change ->> 'done_at')::timestamptz else r.done_at end,
        category = case when v_change ? 'category' then v_change ->> 'category' else r.category end,
        kind = case when v_change ? 'kind' then v_change ->> 'kind' else r.kind end,
        title = case when v_change ? 'title' then v_change ->> 'title' else r.title end,
        summary = case when v_change ? 'summary' then v_change ->> 'summary' else r.summary end,
        priority = case when v_change ? 'priority' then (v_change ->> 'priority')::integer else r.priority end,
        pinned = case when v_change ? 'pinned' then (v_change ->> 'pinned')::boolean else r.pinned end,
        remind_at = case when v_change ? 'remind_at' then (v_change ->> 'remind_at')::date else r.remind_at end,
        tags = case when v_change ? 'tags' then array(select jsonb_array_elements_text(v_change -> 'tags')) else r.tags end,
        entities = case when v_change ? 'entities' then v_change -> 'entities' else r.entities end,
        related = case when v_change ? 'related' then array(select value::uuid from jsonb_array_elements_text(v_change -> 'related')) else r.related end,
        surfaced_reason = case when v_change ? 'surfaced_reason' then v_change ->> 'surfaced_reason' else r.surfaced_reason end,
        surfaced_on = case when v_change ? 'surfaced_on' then (v_change ->> 'surfaced_on')::date else r.surfaced_on end,
        agent_reviewed_at = case when v_change ? 'agent_reviewed_at' then (v_change ->> 'agent_reviewed_at')::timestamptz else r.agent_reviewed_at end,
        locked_fields = case when v_change ? 'locked_fields' then array(select jsonb_array_elements_text(v_change -> 'locked_fields')) else r.locked_fields end,
        deleted_at = case when v_change ? 'deleted_at' then (v_change ->> 'deleted_at')::timestamptz else r.deleted_at end
      where r.id = v_id;
      get diagnostics v_count = row_count;
      if v_count <> 1 then
        raise no_data_found using message = 'Reminder was not updated exactly once';
      end if;
      return jsonb_build_object('saved', true);

    when 'updateChange' then
      v_id := (p_payload ->> 'id')::uuid;
      if jsonb_typeof(v_change) <> 'object' or v_change = '{}'::jsonb
         or exists (select 1 from jsonb_object_keys(v_change) as keys(key)
                    where key not in ('confirmed', 'reverted')) then
        raise invalid_parameter_value using message = 'Invalid decision';
      end if;
      update public.agent_changes c set
        confirmed = case when v_change ? 'confirmed' then (v_change ->> 'confirmed')::boolean else c.confirmed end,
        reverted = case when v_change ? 'reverted' then (v_change ->> 'reverted')::boolean else c.reverted end
      where c.id = v_id and c.needs_ok = true and c.confirmed is null;
      get diagnostics v_count = row_count;
      if v_count <> 1 then
        raise no_data_found using message = 'Decision was not updated exactly once';
      end if;
      return jsonb_build_object('saved', true);

    when 'organizerOpenRows' then
      select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]'::jsonb)
      into v_items from (
        select id, created_at, body, done, category, kind, title, summary,
               priority, pinned, remind_at, tags, entities, related,
               surfaced_reason, surfaced_on, agent_reviewed_at, locked_fields,
               deleted_at
        from public.reminders where done = false and deleted_at is null
      ) r;
      return v_items;

    when 'organizerRuns' then
      v_start := (p_payload ->> 'start')::timestamptz;
      v_end := (p_payload ->> 'end')::timestamptz;
      select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) into v_items from (
        select id, ran_at, note from public.agent_runs
        where ran_at >= v_start and ran_at < v_end
        order by ran_at desc limit 1
      ) r;
      return v_items;

    when 'organizerInsertChanges' then
      if jsonb_typeof(p_payload -> 'rows') <> 'array' then
        raise invalid_parameter_value using message = 'Change rows must be an array';
      end if;
      insert into public.agent_changes (
        entry_id, batch_id, field, old_value, new_value, reason, needs_ok
      ) select entry_id, batch_id, field, old_value, new_value,
               left(reason, 240), coalesce(needs_ok, false)
        from jsonb_to_recordset(p_payload -> 'rows') as x(
          entry_id uuid, batch_id uuid, field text, old_value jsonb,
          new_value jsonb, reason text, needs_ok boolean
        );
      get diagnostics v_count = row_count;
      return jsonb_build_object('inserted', v_count);

    when 'organizerDecisionCount' then
      select count(*)::integer into v_count from public.agent_changes
      where needs_ok = true and confirmed is null and reverted = false;
      return to_jsonb(v_count);

    when 'organizerInsertRun' then
      v_row := p_payload -> 'run';
      insert into public.agent_runs (
        batch_id, organised_ct, attention_ct, decisions_ct, note
      ) values (
        (v_row ->> 'batch_id')::uuid, (v_row ->> 'organised_ct')::integer,
        (v_row ->> 'attention_ct')::integer, (v_row ->> 'decisions_ct')::integer,
        left(v_row ->> 'note', 500)
      ) returning to_jsonb(agent_runs) into v_row;
      return v_row;

    when 'organizerRunExists' then
      v_batch := (p_payload ->> 'batch_id')::uuid;
      return to_jsonb(exists(select 1 from public.agent_runs where batch_id = v_batch));

    when 'organizerDeleteChanges' then
      v_batch := (p_payload ->> 'batch_id')::uuid;
      delete from public.agent_changes where batch_id = v_batch;
      get diagnostics v_count = row_count;
      return jsonb_build_object('deleted', v_count);

    else
      raise invalid_parameter_value using message = 'Unsupported Capture action';
  end case;
end;
$$;

revoke all on function public.capture_server_request(text, jsonb) from public, authenticated;
grant execute on function public.capture_server_request(text, jsonb) to anon, service_role;

alter table public.reminders enable row level security;
alter table public.agent_changes enable row level security;
alter table public.agent_runs enable row level security;
revoke all on table public.reminders from anon, authenticated;
revoke all on table public.agent_changes from anon, authenticated;
revoke all on table public.agent_runs from anon, authenticated;
grant select, insert, update, delete on table public.reminders to service_role;
grant select, insert, update, delete on table public.agent_changes to service_role;
grant select, insert, update, delete on table public.agent_runs to service_role;

comment on function public.capture_server_request(text, jsonb) is
  'Single login-free Capture doorway. Requires a server-only key in x-capture-server-key.';
