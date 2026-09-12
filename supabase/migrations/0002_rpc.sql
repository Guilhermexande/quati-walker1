-- =============================================================================
-- Quati Walker — camada RPC
-- Versão 1.0 — 11/09/2026
--
-- ESTA É A API DO APLICATIVO. O app chama estas funções por nome, com
-- parâmetros. Ele não conhece tabela, não monta query, não escreve SQL.
--
--   supabase.rpc('create_service_request', { p_pet_id: ..., ... })
--
-- Toda função aqui é SECURITY DEFINER com search_path fixo, valida quem chama,
-- e é a única porta de escrita nas tabelas de negócio.
--
-- O que NÃO está aqui, e por quê:
--   create_pix_charge / handle_mp_webhook vivem em Edge Function (Deno), porque
--   precisam do Access Token do Mercado Pago e de rede externa. O Postgres não
--   guarda segredo de terceiro nem faz chamada HTTP de saída.
-- =============================================================================

-- =============================================================================
-- CLIENTE
-- =============================================================================

-- Cria a solicitação. O preço NÃO é parâmetro: vem da tabela pricing.
create or replace function create_service_request(
  p_pet_id       uuid,
  p_service      service_type,
  p_duration_min integer,
  p_address_text text,
  p_lat          double precision,
  p_lng          double precision,
  p_scheduled_at timestamptz
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
declare v_id uuid; v_uid uuid := (select auth.uid()); v_expiradas integer;
begin
  if v_uid is null then raise exception 'não autenticado'; end if;

  select expirations into v_expiradas from public.clients_pay_first where client_id = v_uid;
  if v_expiradas is not null then
    raise exception 'Você tem % reservas expiradas por falta de pagamento nos últimos 30 dias. Pague antes de solicitar.', v_expiradas
      using errcode = 'P0001', hint = 'pagar_antes';
  end if;

  insert into public.service_requests
    (client_id, pet_id, service, duration_minutes, address_text, address_geog,
     scheduled_at, pricing_id, price_cents, commission_cents, payout_cents,
     pet_snapshot, terms_version, terms_accepted_at)
  values
    (v_uid, p_pet_id, p_service, p_duration_min, p_address_text,
     st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography,
     p_scheduled_at,
     -- valores abaixo são sobrescritos pelo trigger assert_request_insert
     (select id from public.pricing limit 1), 1, 0, 1, '{}'::jsonb,
     (select version from public.terms where active), now())
  returning id into v_id;

  return v_id;
end $$;

-- Cancelamento pelo cliente. O split é calculado pelo trigger, não aqui.
create or replace function cancel_request(p_request_id uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
declare v_uid uuid := (select auth.uid()); r public.service_requests;
begin
  select * into r from public.service_requests where id = p_request_id for update;
  if r.id is null then raise exception 'solicitação inexistente'; end if;
  if r.client_id <> v_uid then raise exception 'sem permissão'; end if;
  if r.status in ('completed','expired','cancelled_client','cancelled_walker') then
    raise exception 'este serviço já está encerrado';
  end if;
  if r.status = 'in_progress' then
    raise exception 'serviço em andamento não pode ser cancelado; registre um incidente';
  end if;

  update public.service_requests
     set status = 'cancelled_client', cancelled_by = 'client', cancel_reason = p_reason
   where id = p_request_id;
end $$;

create or replace function submit_review(
  p_request_id uuid, p_rating smallint, p_comment text default null
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
declare v_uid uuid := (select auth.uid()); r public.service_requests; v_id uuid;
begin
  select * into r from public.service_requests where id = p_request_id;
  if r.id is null           then raise exception 'solicitação inexistente'; end if;
  if r.client_id <> v_uid   then raise exception 'somente o cliente do serviço avalia'; end if;

  insert into public.reviews (request_id, client_id, walker_id, rating, comment)
  values (p_request_id, r.client_id, r.walker_id, p_rating, p_comment)
  returning id into v_id;

  return v_id;
end $$;

-- =============================================================================
-- WALKER
-- =============================================================================

-- Pedidos abertos perto do walker. Devolve BAIRRO, nunca o endereço exato:
-- o endereço só aparece depois que ele aceita.
create or replace function open_requests_for_walker()
returns table (
  request_id uuid, service service_type, duration_minutes integer,
  scheduled_at timestamptz, payout_cents integer,
  pet_name text, pet_species text, pet_size text, risk_notes text,
  distance_bucket text
)
language plpgsql stable security definer set search_path = pg_catalog, public, extensions as $$
declare v_uid uuid := (select auth.uid()); wp public.walker_profiles; wl public.walker_locations;
begin
  select * into wp from public.walker_profiles where user_id = v_uid;
  if wp.user_id is null     then raise exception 'perfil de walker não encontrado'; end if;
  if wp.suspended_at is not null then raise exception 'conta suspensa'; end if;
  if wp.mp_user_id is null  then
    raise exception 'conecte sua conta do Mercado Pago para receber pedidos'
      using hint = 'sem_mp';
  end if;

  select * into wl from public.walker_locations where walker_id = v_uid;
  if wl.walker_id is null or not wl.available then return; end if;

  return query
    select sr.id, sr.service, sr.duration_minutes, sr.scheduled_at, sr.payout_cents,
           sr.pet_snapshot->>'name', sr.pet_snapshot->>'species',
           sr.pet_snapshot->>'size',  sr.pet_snapshot->>'risk_notes',
           case when st_distance(wl.geog, sr.address_geog) < 1000 then 'até 1 km'
                when st_distance(wl.geog, sr.address_geog) < 3000 then '1 a 3 km'
                else '3 a 5 km' end
      from public.service_requests sr
     where sr.status = 'requested'
       and sr.scheduled_at > now()
       and st_dwithin(sr.address_geog, wl.geog, 20000)
       and st_dwithin(sr.address_geog, wl.geog, wp.radius_m)
       and (((sr.pet_snapshot->>'species') = 'dog' and wp.accepts_dog)
         or ((sr.pet_snapshot->>'species') = 'cat' and wp.accepts_cat))
       and ((sr.pet_snapshot->>'species') <> 'dog'
         or (sr.pet_snapshot->>'size') <> 'large'
         or wp.accepts_large_dog)
       -- não oferece pedido que colide com serviço que ele já assumiu
       and not exists (
         select 1 from public.service_requests meu
          where meu.walker_id = v_uid
            and meu.status in ('reserved','confirmed','in_progress')
            and tstzrange(meu.scheduled_at, meu.ends_at)
             && tstzrange(sr.scheduled_at,  sr.ends_at))
     order by sr.scheduled_at
     limit 50;
end $$;

-- Aceite. A cláusula `and status = 'requested'` é a trava da corrida: quem
-- chega em segundo lugar afeta zero linhas.
create or replace function accept_request(p_request_id uuid)
returns timestamptz                        -- devolve reserved_until
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
declare v_uid uuid := (select auth.uid()); wp public.walker_profiles; v_until timestamptz;
begin
  select * into wp from public.walker_profiles where user_id = v_uid;
  if wp.user_id is null          then raise exception 'perfil de walker não encontrado'; end if;
  if wp.suspended_at is not null  then raise exception 'conta suspensa'; end if;
  if wp.mp_user_id is null        then raise exception 'conecte sua conta do Mercado Pago'; end if;

  begin
    update public.service_requests
       set status = 'reserved', walker_id = v_uid
     where id = p_request_id
       and status = 'requested'
    returning reserved_until into v_until;
  exception when exclusion_violation then
    raise exception 'você já tem outro serviço nesse horário';
  end;

  if v_until is null then
    raise exception 'este pedido já foi aceito por outro walker'
      using errcode = 'P0001', hint = 'ja_aceito';
  end if;
  return v_until;
end $$;

create or replace function start_service(
  p_request_id uuid, p_lat double precision, p_lng double precision
) returns void
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
declare v_uid uuid := (select auth.uid()); r public.service_requests;
begin
  select * into r from public.service_requests where id = p_request_id for update;
  if r.walker_id is distinct from v_uid then raise exception 'sem permissão'; end if;
  if r.status <> 'confirmed' then
    raise exception 'só é possível iniciar um serviço confirmado (atual: %)', r.status;
  end if;

  update public.service_requests
     set status = 'in_progress',
         start_geog = st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography
   where id = p_request_id;
end $$;

create or replace function finish_service(
  p_request_id uuid, p_lat double precision, p_lng double precision
) returns void
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
declare v_uid uuid := (select auth.uid()); r public.service_requests;
begin
  select * into r from public.service_requests where id = p_request_id for update;
  if r.walker_id is distinct from v_uid then raise exception 'sem permissão'; end if;
  if r.status <> 'in_progress' then raise exception 'o serviço não está em andamento'; end if;

  update public.service_requests
     set status = 'completed',
         end_geog = st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography
   where id = p_request_id;
end $$;

create or replace function walker_cancel(p_request_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
declare v_uid uuid := (select auth.uid()); r public.service_requests;
begin
  select * into r from public.service_requests where id = p_request_id for update;
  if r.walker_id is distinct from v_uid then raise exception 'sem permissão'; end if;
  if r.status not in ('reserved','confirmed') then
    raise exception 'não é possível cancelar neste estado (%)', r.status;
  end if;

  update public.service_requests
     set status = 'cancelled_walker', cancelled_by = 'walker', cancel_reason = p_reason
   where id = p_request_id;
end $$;

-- Tutor não apareceu. Só vale depois de 15 minutos do horário marcado.
create or replace function report_no_show(p_request_id uuid)
returns void
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
declare v_uid uuid := (select auth.uid()); r public.service_requests;
begin
  select * into r from public.service_requests where id = p_request_id for update;
  if r.walker_id is distinct from v_uid then raise exception 'sem permissão'; end if;
  if r.status <> 'confirmed' then raise exception 'estado inválido (%)', r.status; end if;
  if now() < r.scheduled_at + interval '15 minutes' then
    raise exception 'aguarde 15 minutos após o horário marcado';
  end if;

  update public.service_requests
     set status = 'cancelled_client', cancelled_by = 'no_show_client',
         cancel_reason = 'tutor ausente'
   where id = p_request_id;
end $$;

-- Disponibilidade com validade. Sem isso, walker que fechou o app continua
-- recebendo pedido para sempre.
create or replace function set_availability(
  p_available boolean,
  p_lat       double precision default null,
  p_lng       double precision default null,
  p_minutes   integer          default 240
) returns void
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
declare v_uid uuid := (select auth.uid());
begin
  if p_available and (p_lat is null or p_lng is null) then
    raise exception 'localização obrigatória para ficar disponível';
  end if;

  -- Ficar indisponível NÃO apaga a última posição conhecida: sem coordenada
  -- nova, a linha existente mantém a que já tinha.
  insert into public.walker_locations (walker_id, geog, available, available_until)
  values (v_uid,
          coalesce(st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography,
                   st_setsrid(st_makepoint(0, 0), 4326)::geography),
          p_available,
          case when p_available then now() + (p_minutes * interval '1 minute') end)
  on conflict (walker_id) do update
     set geog = case when p_lat is null or p_lng is null
                     then public.walker_locations.geog
                     else excluded.geog end,
         available = excluded.available,
         available_until = excluded.available_until,
         updated_at = now();
end $$;

-- =============================================================================
-- CUSTÓDIA DE CHAVE E INCIDENTES
-- =============================================================================

create or replace function register_key_handover(
  p_walker_id uuid, p_description text
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
declare v_id uuid;
begin
  insert into public.key_custody (client_id, walker_id, description)
  values ((select auth.uid()), p_walker_id, p_description)
  returning id into v_id;
  perform public.log_event('key_custody', v_id, 'handed');
  return v_id;
end $$;

create or replace function confirm_key_return(p_custody_id uuid)
returns void
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
declare v_uid uuid := (select auth.uid()); k public.key_custody;
begin
  select * into k from public.key_custody where id = p_custody_id;
  if k.client_id <> v_uid then raise exception 'somente o tutor confirma a devolução'; end if;
  update public.key_custody
     set returned_at = now(), returned_confirmed_by_client = true
   where id = p_custody_id;
  perform public.log_event('key_custody', p_custody_id, 'returned');
end $$;

-- Termos §11: incidente precisa ser registrado em até 24h.
create or replace function report_incident(
  p_request_id uuid, p_kind text, p_description text,
  p_occurred_at timestamptz, p_photos text[] default null
) returns uuid
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
declare v_uid uuid := (select auth.uid()); r public.service_requests; v_id uuid;
begin
  select * into r from public.service_requests where id = p_request_id;
  if r.id is null then raise exception 'solicitação inexistente'; end if;
  if v_uid not in (r.client_id, r.walker_id) then raise exception 'sem permissão'; end if;
  if p_occurred_at < now() - interval '24 hours' then
    raise exception 'o prazo de 24 horas para registrar o incidente venceu';
  end if;

  insert into public.incidents (request_id, reported_by, kind, description, occurred_at, photos)
  values (p_request_id, v_uid, p_kind, p_description, p_occurred_at, p_photos)
  returning id into v_id;

  perform public.log_event('incident', v_id, 'reported',
                           jsonb_build_object('request', p_request_id, 'kind', p_kind));
  return v_id;
end $$;

-- =============================================================================
-- SERVIDOR — chamado só pela Edge Function, nunca pelo app
-- =============================================================================

-- Registra a cobrança PIX criada no Mercado Pago.
create or replace function server_register_payment(
  p_request_id  uuid, p_idempotency_key text, p_mp_payment_id text,
  p_qr_code text, p_qr_code_base64 text, p_expires_at timestamptz
) returns uuid
language plpgsql set search_path = pg_catalog, public, extensions as $$
declare r public.service_requests; v_id uuid;
begin
  if current_user <> 'service_role' then raise exception 'somente o servidor'; end if;
  select * into r from public.service_requests where id = p_request_id;
  if r.status <> 'reserved' then
    raise exception 'cobrança só para solicitação reservada (atual: %)', r.status;
  end if;

  insert into public.payments
    (request_id, idempotency_key, mp_payment_id, amount_cents, fee_cents,
     qr_code, qr_code_base64, expires_at)
  values
    (p_request_id, p_idempotency_key, p_mp_payment_id, r.price_cents, r.commission_cents,
     p_qr_code, p_qr_code_base64, p_expires_at)
  on conflict (idempotency_key) do update set updated_at = now()
  returning id into v_id;

  return v_id;
end $$;

-- Trata o webhook. Idempotente por mp_event_id: reenvio do mesmo evento não
-- faz nada. Pagamento que chega depois da expiração NÃO é aplicado — devolve
-- 'estornar' para a Edge Function providenciar o estorno.
create or replace function server_apply_payment_event(
  p_mp_event_id text, p_mp_payment_id text, p_status payment_status, p_payload jsonb
) returns text
language plpgsql set search_path = pg_catalog, public, extensions as $$
declare p public.payments; r public.service_requests;
begin
  if current_user <> 'service_role' then raise exception 'somente o servidor'; end if;

  if exists (select 1 from public.payment_events where mp_event_id = p_mp_event_id) then
    return 'duplicado';
  end if;

  select * into p from public.payments where mp_payment_id = p_mp_payment_id for update;
  if p.id is null then return 'pagamento_desconhecido'; end if;

  insert into public.payment_events (payment_id, mp_event_id, payload)
  values (p.id, p_mp_event_id, p_payload);

  update public.payments set status = p_status, mp_event_id = p_mp_event_id where id = p.id;

  if p_status <> 'approved' then return 'registrado'; end if;

  select * into r from public.service_requests where id = p.request_id for update;

  if r.status = 'reserved' then
    update public.service_requests set status = 'confirmed' where id = r.id;
    return 'confirmado';
  elsif r.status in ('confirmed','in_progress','completed') then
    return 'ja_confirmado';
  else
    -- expirou ou foi cancelado antes de o PIX cair
    perform public.log_event('payment', p.id, 'pagamento_tardio',
                             jsonb_build_object('request_status', r.status));
    return 'estornar';
  end if;
end $$;

-- =============================================================================
-- PERMISSÕES
-- =============================================================================

do $$
declare f text;
begin
  for f in
    select p.oid::regprocedure::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'server\_%'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;

grant execute on function
  create_service_request(uuid, service_type, integer, text, double precision, double precision, timestamptz),
  cancel_request(uuid, text),
  submit_review(uuid, smallint, text),
  open_requests_for_walker(),
  accept_request(uuid),
  start_service(uuid, double precision, double precision),
  finish_service(uuid, double precision, double precision),
  walker_cancel(uuid, text),
  report_no_show(uuid),
  set_availability(boolean, double precision, double precision, integer),
  register_key_handover(uuid, text),
  confirm_key_return(uuid),
  report_incident(uuid, text, text, timestamptz, text[])
to authenticated;

revoke execute on function anonymize_profile(uuid), expire_stale_requests(integer)
  from public, anon, authenticated;

-- As funções server_* e as de manutenção pertencem ao servidor.
grant execute on all functions in schema public to service_role;
