-- =============================================================================
-- Quati Walker — schema
-- Postgres 15 / Supabase · PostGIS
-- Versão 2.0 — 11/09/2026
--
-- Esta versão substitui a 1.0 inteira. A 1.0 foi auditada por quatro revisores
-- independentes e reprovada: 29 problemas críticos, entre eles "o cliente
-- confirma o serviço sem pagar" e "nenhum walker consegue aceitar pedido".
--
-- PRINCÍPIO QUE ORGANIZA TUDO ABAIXO:
--   O aplicativo tem permissão de LEITURA. Nada mais.
--   Toda escrita passa por função RPC (arquivo 0002_rpc.sql), que roda no
--   servidor, valida e carimba. O app nunca escreve uma linha diretamente.
--
-- Decisões em docs/ADR-001-decisoes.md.
-- =============================================================================

create extension if not exists postgis;
create extension if not exists pgcrypto;
create extension if not exists btree_gist;   -- exclusion constraints com igualdade

-- =============================================================================
-- 1. TIPOS
-- =============================================================================

create type user_role       as enum ('client', 'walker', 'admin');
create type pet_species     as enum ('dog', 'cat');
create type pet_size        as enum ('small', 'medium', 'large');
create type service_type    as enum ('walk', 'visit');

create type request_status as enum (
  'requested', 'reserved', 'confirmed', 'in_progress',
  'completed', 'expired', 'cancelled_client', 'cancelled_walker'
);

create type payment_status as enum ('pending', 'approved', 'rejected', 'refunded', 'cancelled');
create type cancel_actor   as enum ('client', 'walker', 'no_show_client', 'force_majeure');

-- =============================================================================
-- 2. TERMOS — versão vigente vem do banco, não do celular
-- =============================================================================

create table terms (
  version      text primary key,
  body_url     text,
  published_at timestamptz not null default now(),
  active       boolean     not null default false
);

create unique index terms_uma_ativa on terms (active) where active;
insert into terms (version, active) values ('1.0', true);

-- =============================================================================
-- 4. PESSOAS
-- =============================================================================

create table profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  role        user_role   not null default 'client',
  full_name   text        not null check (length(btrim(full_name)) >= 3),
  phone_e164  text        not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  email       text        not null,
  cpf_digits  text        check (cpf_digits ~ '^[0-9]{11}$'),   -- só dígitos
  anonymized_at timestamptz,                                    -- LGPD, ver seção 12
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- CPF único só entre contas vivas.
create unique index profiles_cpf_unico on profiles (cpf_digits)
  where cpf_digits is not null and anonymized_at is null;

create index profiles_phone_idx on profiles (phone_e164);
create index profiles_email_idx on profiles (lower(email));

-- O papel NUNCA muda por update do próprio usuário. Vira admin só por
-- service_role, e o trigger é a última linha de defesa se uma policy vazar.
create or replace function guard_profile_update() returns trigger
language plpgsql set search_path = pg_catalog, public, extensions as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.role       := old.role;
    new.id         := old.id;
    new.created_at := old.created_at;
    new.anonymized_at := old.anonymized_at;
    if new.role = 'admin' then
      raise exception 'papel admin só é concedido pelo servidor';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger trg_profile_guard
  before update on profiles
  for each row execute function guard_profile_update();

create table walker_profiles (
  user_id           uuid primary key references profiles (id) on delete cascade,
  bio               text,
  radius_m          integer     not null default 5000 check (radius_m between 500 and 20000),
  accepts_dog       boolean     not null default true,
  accepts_cat       boolean     not null default false,
  accepts_large_dog boolean     not null default false,
  max_pets_per_walk smallint    not null default 1 check (max_pets_per_walk between 1 and 3),
  -- PII / financeiro: nunca exposto pela view pública
  mp_user_id        text unique,
  pix_key           text,
  -- campos de confiança: só o servidor escreve (trigger abaixo)
  verified_at       timestamptz,
  suspended_at      timestamptz,
  suspend_reason    text,
  rating_avg        numeric(3,2),
  rating_count      integer     not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- O walker edita bio, raio e preferências. Não edita a própria reputação,
-- verificação, suspensão nem a conta do Mercado Pago.
create or replace function guard_walker_profile() returns trigger
language plpgsql set search_path = pg_catalog, public, extensions as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.verified_at    := old.verified_at;
    new.suspended_at   := old.suspended_at;
    new.suspend_reason := old.suspend_reason;
    new.rating_avg     := old.rating_avg;
    new.rating_count   := old.rating_count;
    new.mp_user_id     := old.mp_user_id;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger trg_walker_profile_guard
  before update on walker_profiles
  for each row execute function guard_walker_profile();

-- Walker precisa de CPF válido.
create or replace function assert_walker_has_cpf() returns trigger
language plpgsql set search_path = pg_catalog, public, extensions as $$
begin
  if new.role = 'walker' and new.cpf_digits is null then
    raise exception 'Walker precisa de CPF';
  end if;
  return new;
end $$;

create trigger trg_walker_cpf
  before insert or update on profiles
  for each row execute function assert_walker_has_cpf();

-- Vitrine pública do walker: só o que o cliente precisa ver para escolher.
-- Roda como dono (security_invoker off) porque filtra colunas na mão.
create view walkers_public as
  select w.user_id, p.full_name, w.bio, w.rating_avg, w.rating_count,
         w.accepts_dog, w.accepts_cat, w.accepts_large_dog,
         (w.verified_at is not null) as verified
    from walker_profiles w
    join profiles p on p.id = w.user_id
   where w.suspended_at is null
     and p.anonymized_at is null;

revoke all on walkers_public from public, anon;
grant select on walkers_public to authenticated;

-- --- Autorização ------------------------------------------------------------
-- Definidas aqui, e não no topo, porque consultam `profiles`: uma função
-- `language sql` tem o corpo validado na criação e não compila antes da tabela.
--
-- search_path fixo em toda função SECURITY DEFINER. Sem isso, um schema
-- malicioso no search_path do chamador sequestra a resolução de nomes e a
-- função roda código de terceiro com privilégio de dono.

create or replace function my_role() returns user_role
language sql stable security definer set search_path = pg_catalog, public, extensions as $$
  select p.role from public.profiles p where p.id = (select auth.uid());
$$;

revoke execute on function my_role() from public;
grant  execute on function my_role() to authenticated;

create or replace function is_admin() returns boolean
language sql stable security definer set search_path = pg_catalog, public, extensions as $$
  select exists (select 1 from public.profiles p
                  where p.id = (select auth.uid()) and p.role = 'admin');
$$;

revoke execute on function is_admin() from public;
grant  execute on function is_admin() to authenticated;

-- =============================================================================
-- 5. ANIMAIS
-- =============================================================================

create table pets (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid        not null references profiles (id) on delete cascade,
  name              text        not null,
  species           pet_species not null,
  size              pet_size,
  breed             text,
  photo_path        text,
  -- Termos §8: vacina antirrábica com validade, não um booleano decorativo
  rabies_valid_until date,
  risk_notes         text,
  archived_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint dog_requires_size check (species <> 'dog' or size is not null)
);

create index pets_owner_idx on pets (owner_id) where archived_at is null;

-- =============================================================================
-- 6. PREÇOS — versionados, com histórico imutável
-- =============================================================================

create table pricing (
  id               uuid primary key default gen_random_uuid(),
  service          service_type not null,
  duration_minutes integer      not null check (duration_minutes > 0),
  price_cents      integer      not null check (price_cents > 0),
  commission_bps   integer      not null check (commission_bps between 0 and 10000),
  active_from      timestamptz  not null default now(),
  active_to        timestamptz,
  created_by       uuid references profiles (id),
  created_at       timestamptz  not null default now(),

  constraint janela_valida check (active_to is null or active_to > active_from),
  -- Duas tabelas de preço para o mesmo serviço nunca se sobrepõem no tempo.
  constraint pricing_sem_sobreposicao exclude using gist (
    service          with =,
    duration_minutes with =,
    tstzrange(active_from, active_to) with &&
  )
);

insert into pricing (service, duration_minutes, price_cents, commission_bps) values
  ('walk',  60, 4000, 2000),
  ('visit', 60, 4000, 2000);

create or replace function current_pricing(p_service service_type, p_duration integer)
returns pricing
language sql stable set search_path = pg_catalog, public, extensions as $$
  select * from public.pricing
   where service = p_service
     and duration_minutes = p_duration
     and active_from <= now()
     and (active_to is null or active_to > now())
   order by active_from desc
   limit 1;
$$;

-- =============================================================================
-- 7. SOLICITAÇÕES DE SERVIÇO
-- =============================================================================

create table service_requests (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid           not null references profiles (id) on delete restrict,
  pet_id             uuid           not null references pets (id)     on delete restrict,
  walker_id          uuid                    references profiles (id) on delete restrict,

  service            service_type   not null,
  duration_minutes   integer        not null check (duration_minutes > 0),
  status             request_status not null default 'requested',

  address_text       text           not null,
  address_geog       geography(Point, 4326) not null,
  scheduled_at       timestamptz    not null,
  -- Fim previsto. Coluna comum, preenchida pelo trigger de INSERT.
  -- Não pode ser GENERATED: `timestamptz + interval` depende do fuso da sessão,
  -- e o Postgres exige expressão imutável em coluna gerada.
  ends_at            timestamptz    not null,

  -- SNAPSHOT do preço no instante do pedido. Derivado pelo servidor.
  pricing_id         uuid           not null references pricing (id),
  price_cents        integer        not null check (price_cents > 0),
  commission_cents   integer        not null check (commission_cents >= 0),
  payout_cents       integer        not null check (payout_cents >= 0),

  -- SNAPSHOT do animal. O tutor não apaga risk_notes depois de um incidente.
  pet_snapshot       jsonb          not null,

  terms_version      text           not null references terms (version),
  terms_accepted_at  timestamptz    not null,

  reserved_until     timestamptz,
  accepted_at        timestamptz,
  confirmed_at       timestamptz,
  started_at         timestamptz,
  completed_at       timestamptz,
  cancelled_at       timestamptz,
  cancelled_by       cancel_actor,
  cancel_reason      text,

  start_geog         geography(Point, 4326),   -- prova de que o walker chegou
  end_geog           geography(Point, 4326),

  -- Fechamento financeiro. É daqui que sai a base da nota fiscal (Decisão 9).
  refund_cents       integer check (refund_cents >= 0),
  final_payout_cents integer check (final_payout_cents >= 0),
  final_commission_cents integer check (final_commission_cents >= 0),

  created_at         timestamptz    not null default now(),
  updated_at         timestamptz    not null default now(),

  constraint split_fecha        check (price_cents = commission_cents + payout_cents),
  constraint reserva_tem_walker check (status <> 'reserved' or (walker_id is not null and reserved_until is not null)),
  constraint fechamento_fecha   check (
    final_commission_cents is null
    or price_cents = coalesce(refund_cents,0) + final_commission_cents + coalesce(final_payout_cents,0)
  ),

  -- Um walker não pode ter dois serviços ativos com horários sobrepostos.
  constraint walker_sem_overbooking exclude using gist (
    walker_id with =,
    tstzrange(scheduled_at, ends_at) with &&
  ) where (walker_id is not null and status in ('reserved','confirmed','in_progress'))
);

create index sr_abertos_idx    on service_requests (scheduled_at) where status = 'requested';
create index sr_reservados_idx on service_requests (reserved_until) where status = 'reserved';
create index sr_cliente_idx    on service_requests (client_id, created_at desc);
create index sr_walker_idx     on service_requests (walker_id, created_at desc);
create index sr_geog_idx       on service_requests using gist (address_geog);

-- --- Espécie × serviço ------------------------------------------------------
create or replace function assert_service_matches_species() returns trigger
language plpgsql set search_path = pg_catalog, public, extensions as $$
declare v_species public.pet_species;
begin
  select species into v_species from public.pets where id = new.pet_id;
  if v_species = 'cat' and new.service <> 'visit' then
    raise exception 'Gato só aceita visita em casa';
  end if;
  if v_species = 'dog' and new.service <> 'walk' then
    raise exception 'Cão só aceita passeio';
  end if;
  return new;
end $$;

create trigger trg_service_species
  before insert on service_requests
  for each row execute function assert_service_matches_species();

-- --- INSERT: o servidor decide preço, estado e carimbos ---------------------
-- Roda SEMPRE, inclusive para service_role, para que nem a Edge Function
-- consiga gravar um preço divergente da tabela pricing.
create or replace function assert_request_insert() returns trigger
language plpgsql set search_path = pg_catalog, public, extensions as $$
declare p public.pricing; v_pet public.pets;
begin
  new.status := 'requested';
  new.walker_id := null;  new.reserved_until := null;
  new.accepted_at := null; new.confirmed_at := null;
  new.started_at := null;  new.completed_at := null;
  new.cancelled_at := null; new.cancelled_by := null; new.cancel_reason := null;
  new.refund_cents := null; new.final_payout_cents := null; new.final_commission_cents := null;

  select * into v_pet from public.pets where id = new.pet_id;
  if v_pet.owner_id is distinct from new.client_id then
    raise exception 'o animal não pertence a este cliente';
  end if;
  if v_pet.archived_at is not null then
    raise exception 'animal arquivado';
  end if;
  if v_pet.rabies_valid_until is null or v_pet.rabies_valid_until < current_date then
    raise exception 'vacina antirrábica vencida ou não informada';
  end if;

  if new.scheduled_at <= now() + interval '15 minutes' then
    raise exception 'o horário precisa estar ao menos 15 minutos no futuro';
  end if;
  new.ends_at := new.scheduled_at + (new.duration_minutes * interval '1 minute');

  p := public.current_pricing(new.service, new.duration_minutes);
  if p.id is null then
    raise exception 'sem preço vigente para % / % min', new.service, new.duration_minutes;
  end if;
  new.pricing_id       := p.id;
  new.price_cents      := p.price_cents;
  new.commission_cents := (p.price_cents * p.commission_bps) / 10000;
  new.payout_cents     := p.price_cents - new.commission_cents;

  new.pet_snapshot := jsonb_build_object(
    'name', v_pet.name, 'species', v_pet.species, 'size', v_pet.size,
    'breed', v_pet.breed, 'risk_notes', v_pet.risk_notes,
    'rabies_valid_until', v_pet.rabies_valid_until);

  select version into new.terms_version from public.terms where active;
  new.terms_accepted_at := now();
  return new;
end $$;

create trigger trg_request_insert
  before insert on service_requests
  for each row execute function assert_request_insert();

-- --- UPDATE: colunas congeladas, transições válidas, carimbos do servidor ---
create or replace function assert_status_transition() returns trigger
language plpgsql set search_path = pg_catalog, public, extensions as $$
declare ok boolean;
begin
  -- 1) o que nasceu com a solicitação nunca muda
  if (new.client_id, new.pet_id, new.service, new.duration_minutes, new.pricing_id,
      new.price_cents, new.commission_cents, new.payout_cents, new.pet_snapshot,
      new.terms_version, new.terms_accepted_at, new.scheduled_at, new.ends_at, new.created_at)
     is distinct from
     (old.client_id, old.pet_id, old.service, old.duration_minutes, old.pricing_id,
      old.price_cents, old.commission_cents, old.payout_cents, old.pet_snapshot,
      old.terms_version, old.terms_accepted_at, old.scheduled_at, old.ends_at, old.created_at)
  then
    raise exception 'coluna congelada alterada na solicitação %', old.id;
  end if;

  -- 2) carimbos e dinheiro de fechamento: só este trigger escreve
  new.reserved_until := old.reserved_until;
  new.accepted_at    := old.accepted_at;
  new.confirmed_at   := old.confirmed_at;
  new.started_at     := old.started_at;
  new.completed_at   := old.completed_at;
  new.cancelled_at   := old.cancelled_at;
  new.refund_cents   := old.refund_cents;
  new.final_payout_cents     := old.final_payout_cents;
  new.final_commission_cents := old.final_commission_cents;
  new.updated_at := now();

  if old.status = new.status then
    if new.walker_id is distinct from old.walker_id then
      raise exception 'walker_id só muda na transição requested -> reserved';
    end if;
    return new;
  end if;

  ok := case old.status
    when 'requested'   then new.status in ('reserved', 'cancelled_client', 'expired')
    when 'reserved'    then new.status in ('confirmed', 'expired', 'cancelled_client', 'cancelled_walker')
    when 'confirmed'   then new.status in ('in_progress', 'cancelled_client', 'cancelled_walker')
    when 'in_progress' then new.status in ('completed')
    else false
  end;
  if not ok then
    raise exception 'Transição inválida: % -> %', old.status, new.status;
  end if;

  if new.status = 'reserved' then
    if new.walker_id is null then raise exception 'reserva sem walker'; end if;
    new.accepted_at    := now();
    new.reserved_until := now() + interval '10 minutes';
  elsif new.status = 'confirmed' then
    new.confirmed_at := now();
  elsif new.status = 'in_progress' then
    new.started_at := now();
  elsif new.status = 'completed' then
    new.completed_at := now();
    new.final_payout_cents     := old.payout_cents;
    new.final_commission_cents := old.commission_cents;
    new.refund_cents           := 0;
  elsif new.status in ('cancelled_client','cancelled_walker','expired') then
    new.cancelled_at := now();

    -- Split do cancelamento (ADR decisão 4). Calculado AQUI, nunca pelo app.
    -- Só há dinheiro a dividir se o serviço chegou a ser pago.
    if old.status in ('confirmed','in_progress') then
      declare horas numeric := extract(epoch from (old.scheduled_at - now())) / 3600.0;
      begin
        if new.status = 'cancelled_walker'
           or new.cancelled_by = 'force_majeure'
           or new.status = 'expired'
           or (new.cancelled_by = 'client' and horas >= 2) then
          new.refund_cents           := old.price_cents;      -- devolve tudo
          new.final_payout_cents     := 0;
          new.final_commission_cents := 0;

        elsif new.cancelled_by = 'no_show_client' then
          new.refund_cents           := 0;                    -- walker foi e esperou
          new.final_payout_cents     := old.payout_cents;
          new.final_commission_cents := old.commission_cents;

        else                                                  -- cliente, menos de 2h
          new.refund_cents           := old.price_cents / 2;
          new.final_payout_cents     := old.payout_cents / 2;
          new.final_commission_cents := old.price_cents - new.refund_cents - new.final_payout_cents;
        end if;
      end;
    else
      -- nunca foi pago: não há reembolso nem comissão a apurar
      new.refund_cents           := 0;
      new.final_payout_cents     := null;
      new.final_commission_cents := null;
    end if;
  end if;

  return new;
end $$;

create trigger trg_status_transition
  before update on service_requests
  for each row execute function assert_status_transition();

-- =============================================================================
-- 8. PAGAMENTOS
-- =============================================================================

create table payments (
  id               uuid primary key default gen_random_uuid(),
  request_id       uuid           not null references service_requests (id) on delete restrict,
  mp_payment_id    text unique,
  idempotency_key  text unique not null,
  amount_cents     integer        not null check (amount_cents > 0),
  fee_cents        integer        not null check (fee_cents >= 0),
  status           payment_status not null default 'pending',
  status_rank      smallint       not null default 0,   -- impede retrocesso do webhook
  qr_code          text,
  qr_code_base64   text,
  expires_at       timestamptz,
  approved_at      timestamptz,
  mp_event_id      text unique,       -- idempotência do webhook, evento a evento
  created_at       timestamptz    not null default now(),
  updated_at       timestamptz    not null default now()
);

-- Dados crus do Mercado Pago ficam separados: contêm PII do pagador e o walker
-- não tem nada que ver isso.
create table payment_events (
  id           bigserial primary key,
  payment_id   uuid references payments (id) on delete cascade,
  mp_event_id  text unique,
  payload      jsonb not null,
  received_at  timestamptz not null default now()
);

create index payments_request_idx on payments (request_id);
create unique index payments_um_aprovado on payments (request_id) where status = 'approved';
create unique index payments_um_pendente on payments (request_id) where status = 'pending';

-- O valor cobrado tem que bater com o snapshot do pedido.
create or replace function assert_payment_matches_request() returns trigger
language plpgsql set search_path = pg_catalog, public, extensions as $$
declare r public.service_requests;
begin
  select * into r from public.service_requests where id = new.request_id;
  if new.amount_cents <> r.price_cents then
    raise exception 'valor do pagamento (%) difere do pedido (%)', new.amount_cents, r.price_cents;
  end if;
  if new.fee_cents <> r.commission_cents then
    raise exception 'comissão do pagamento (%) difere do pedido (%)', new.fee_cents, r.commission_cents;
  end if;
  return new;
end $$;

create trigger trg_payment_matches
  before insert on payments
  for each row execute function assert_payment_matches_request();

-- Webhook fora de ordem não rebaixa um pagamento aprovado.
create or replace function guard_payment_status() returns trigger
language plpgsql set search_path = pg_catalog, public, extensions as $$
declare rank_novo smallint;
begin
  rank_novo := case new.status
                 when 'pending' then 0 when 'rejected' then 1 when 'cancelled' then 1
                 when 'approved' then 2 when 'refunded' then 3 end;
  if rank_novo < old.status_rank then
    raise notice 'evento fora de ordem ignorado: % (rank %) < rank %',
                 new.status, rank_novo, old.status_rank;
    return old;
  end if;
  new.status_rank := rank_novo;
  new.updated_at  := now();
  if new.status = 'approved' and old.status <> 'approved' then
    new.approved_at := now();
  end if;
  return new;
end $$;

create trigger trg_payment_status
  before update on payments
  for each row execute function guard_payment_status();

-- Estornos: um pagamento pode ter reembolso parcial (cancelamento de 50%).
create table refunds (
  id             uuid primary key default gen_random_uuid(),
  payment_id     uuid    not null references payments (id) on delete restrict,
  mp_refund_id   text unique,
  amount_cents   integer not null check (amount_cents > 0),
  reason         text,
  created_at     timestamptz not null default now()
);

create index refunds_payment_idx on refunds (payment_id);

-- =============================================================================
-- 9. AVALIAÇÕES
-- =============================================================================

create table reviews (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid unique not null references service_requests (id) on delete cascade,
  client_id   uuid        not null references profiles (id) on delete cascade,
  walker_id   uuid        not null references profiles (id) on delete cascade,
  rating      smallint    not null check (rating between 1 and 5),
  comment     text,
  created_at  timestamptz not null default now()
);

create index reviews_walker_idx on reviews (walker_id);

-- A avaliação precisa corresponder ao serviço: mesmo cliente, mesmo walker,
-- serviço concluído. Sem isso, derrubar a nota de um walker custa um POST.
create or replace function assert_review_matches_request() returns trigger
language plpgsql set search_path = pg_catalog, public, extensions as $$
declare r public.service_requests;
begin
  select * into r from public.service_requests where id = new.request_id;
  if r.id is null                          then raise exception 'solicitação inexistente'; end if;
  if r.status <> 'completed'               then raise exception 'só se avalia serviço concluído'; end if;
  if r.client_id is distinct from new.client_id then raise exception 'quem avalia não é o cliente do serviço'; end if;
  if r.walker_id is distinct from new.walker_id then raise exception 'walker avaliado não é o do serviço'; end if;
  if r.completed_at < now() - interval '30 days' then raise exception 'prazo de avaliação encerrado'; end if;
  return new;
end $$;

create trigger trg_review_matches
  before insert on reviews
  for each row execute function assert_review_matches_request();

-- Rating agregado. Ramifica por TG_OP: em DELETE a variável NEW não existe, e
-- lê-la era o que antes impedia apagar a conta de qualquer usuário.
create or replace function refresh_walker_rating() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
declare v_walker uuid;
begin
  if tg_op = 'DELETE' then v_walker := old.walker_id;
  else                     v_walker := new.walker_id;
  end if;
  update public.walker_profiles w
     set rating_avg   = sub.avg_rating,
         rating_count = sub.n
    from (select avg(rating)::numeric(3,2) as avg_rating, count(*) as n
            from public.reviews where walker_id = v_walker) sub
   where w.user_id = v_walker;
  return null;
end $$;

create trigger trg_refresh_rating
  after insert or update or delete on reviews
  for each row execute function refresh_walker_rating();

-- =============================================================================
-- 10. LOCALIZAÇÃO E MATCHING
-- =============================================================================

create table walker_locations (
  walker_id    uuid primary key references profiles (id) on delete cascade,
  geog         geography(Point, 4326) not null,
  available    boolean     not null default false,
  -- Disponibilidade com validade: walker que fechou o app não fica "disponível"
  -- para sempre.
  available_until timestamptz,
  updated_at   timestamptz not null default now()
);

create index walker_locations_geog_idx on walker_locations using gist (geog)
  where available;

-- Walkers aptos para uma solicitação.
-- SECURITY DEFINER porque precisa ler walker_locations de OUTRAS pessoas, que
-- a RLS esconde. Devolve distância em FAIXA, nunca o valor exato: distância
-- exata de três pedidos permite trilaterar a casa de alguém.
create or replace function walkers_for_request(p_request_id uuid)
returns table (walker_id uuid, full_name text, rating_avg numeric, distance_bucket text)
language plpgsql stable security definer set search_path = pg_catalog, public, extensions as $$
declare r public.service_requests; v_pet_species public.pet_species; v_pet_size public.pet_size;
begin
  select * into r from public.service_requests where id = p_request_id;
  if r.id is null then raise exception 'solicitação inexistente'; end if;
  if r.client_id <> (select auth.uid()) and not public.is_admin() then
    raise exception 'sem permissão';
  end if;

  v_pet_species := (r.pet_snapshot->>'species')::public.pet_species;
  v_pet_size    := nullif(r.pet_snapshot->>'size','')::public.pet_size;

  return query
    select wl.walker_id,
           p.full_name,
           wp.rating_avg,
           case when st_distance(wl.geog, r.address_geog) < 1000 then 'até 1 km'
                when st_distance(wl.geog, r.address_geog) < 3000 then '1 a 3 km'
                else '3 a 5 km' end
      from public.walker_locations wl
      join public.walker_profiles wp on wp.user_id = wl.walker_id
      join public.profiles p         on p.id       = wl.walker_id
     where wl.available
       and (wl.available_until is null or wl.available_until > now())
       and wp.suspended_at is null
       and wp.mp_user_id is not null          -- sem conta MP não há split (Decisão 5)
       and p.anonymized_at is null
       -- literal fixo primeiro: é o que o índice GiST consegue usar
       and st_dwithin(wl.geog, r.address_geog, 20000)
       and st_dwithin(wl.geog, r.address_geog, wp.radius_m)
       and ((v_pet_species = 'dog' and wp.accepts_dog) or (v_pet_species = 'cat' and wp.accepts_cat))
       and (v_pet_species <> 'dog' or v_pet_size <> 'large' or wp.accepts_large_dog)
     order by st_distance(wl.geog, r.address_geog)
     limit 20;
end $$;

revoke execute on function walkers_for_request(uuid) from public;
grant  execute on function walkers_for_request(uuid) to authenticated;

-- =============================================================================
-- 11. CUSTÓDIA DE CHAVE E INCIDENTES (Termos §10 e §11)
-- =============================================================================

create table key_custody (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references profiles (id) on delete cascade,
  walker_id     uuid not null references profiles (id) on delete cascade,
  description   text not null,              -- "chave da porta social", "senha da portaria"
  handed_at     timestamptz not null default now(),
  handed_confirmed_by_walker boolean not null default false,
  returned_at   timestamptz,
  returned_confirmed_by_client boolean not null default false,
  lost_at       timestamptz,
  notes         text
);

create index key_custody_abertas on key_custody (walker_id) where returned_at is null;

create table incidents (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references service_requests (id) on delete restrict,
  reported_by uuid not null references profiles (id),
  kind        text not null,   -- fuga, mordida, ferimento, atraso, dano, outro
  description text not null,
  photos      text[],
  vet_report  text,
  occurred_at timestamptz not null,
  reported_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution  text
);

create index incidents_request_idx on incidents (request_id);

-- =============================================================================
-- 12. TRILHA DE EVENTOS
--
-- Sem isto, um serviço que deu errado é indepurável: não há como saber o que
-- aconteceu, em que ordem, nem quem fez.
-- =============================================================================

create table events (
  id          bigserial primary key,
  entity      text        not null,        -- 'service_request', 'profile', 'payment'
  entity_id   uuid        not null,
  action      text        not null,
  actor_id    uuid,
  actor_role  text,
  data        jsonb,
  created_at  timestamptz not null default now()
);

create index events_entity_idx on events (entity, entity_id, created_at desc);
create index events_time_idx    on events (created_at desc);

create or replace function log_event(
  p_entity text, p_entity_id uuid, p_action text, p_data jsonb default null
) returns void
language sql security definer set search_path = pg_catalog, public, extensions as $$
  insert into public.events (entity, entity_id, action, actor_id, actor_role, data)
  values (p_entity, p_entity_id, p_action, (select auth.uid()),
          (select role::text from public.profiles where id = (select auth.uid())), p_data);
$$;

-- Toda mudança de status vira evento, sem o app precisar lembrar de registrar.
create or replace function log_request_change() returns trigger
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
begin
  if tg_op = 'INSERT' then
    insert into public.events (entity, entity_id, action, actor_id, data)
    values ('service_request', new.id, 'created', (select auth.uid()),
            jsonb_build_object('service', new.service, 'price_cents', new.price_cents));
  elsif old.status is distinct from new.status then
    insert into public.events (entity, entity_id, action, actor_id, data)
    values ('service_request', new.id, 'status:' || new.status, (select auth.uid()),
            jsonb_build_object('de', old.status, 'para', new.status, 'walker', new.walker_id));
  end if;
  return null;
end $$;

create trigger trg_log_request
  after insert or update on service_requests
  for each row execute function log_request_change();

-- =============================================================================
-- 13. MANUTENÇÃO
-- =============================================================================

-- Expira reservas não pagas E pedidos abertos que ninguém aceitou.
-- FOR UPDATE SKIP LOCKED e limite por rodada: não trava a tabela nem briga
-- com o webhook que está confirmando um pagamento no mesmo instante.
create or replace function expire_stale_requests(p_limit integer default 500)
returns integer
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
declare n integer := 0;
begin
  with alvo as (
    select id from public.service_requests
     where (status = 'reserved'  and reserved_until < now())
        or (status = 'requested' and scheduled_at   < now())
     order by updated_at
     limit p_limit
     for update skip locked
  )
  update public.service_requests sr
     set status = 'expired'
    from alvo
   where sr.id = alvo.id
     -- não expira reserva cujo PIX já foi aprovado e está a caminho
     and not exists (select 1 from public.payments p
                      where p.request_id = sr.id and p.status = 'approved');
  get diagnostics n = row_count;
  return n;
end $$;

-- Anti-abuso: clientes que deixaram 3+ reservas expirarem em 30 dias.
-- security_invoker garante que a RLS de quem consulta continua valendo.
create view clients_pay_first with (security_invoker = true) as
  select client_id, count(*) as expirations
    from service_requests
   where status = 'expired'
     and walker_id is not null          -- só conta expiração por falta de pagamento
     and cancelled_at > now() - interval '30 days'
   group by client_id
  having count(*) >= 3;

-- LGPD: anonimização em vez de exclusão física, que quebraria o histórico
-- financeiro que a lei manda guardar.
create or replace function anonymize_profile(p_user uuid) returns void
language plpgsql security definer set search_path = pg_catalog, public, extensions as $$
begin
  update public.profiles
     set full_name  = 'Usuário removido',
         email      = 'removido+' || left(md5(id::text), 12) || '@invalido',
         phone_e164 = '+550000000000',
         cpf_digits = null,
         anonymized_at = now()
   where id = p_user;

  update public.walker_profiles set bio = null, pix_key = null where user_id = p_user;
  update public.pets set archived_at = now(), photo_path = null, risk_notes = null
   where owner_id = p_user;
  delete from public.walker_locations where walker_id = p_user;

  perform public.log_event('profile', p_user, 'anonymized');
end $$;

create or replace function touch_updated_at() returns trigger
language plpgsql set search_path = pg_catalog, public, extensions as $$
begin new.updated_at := now(); return new; end $$;

-- profiles, walker_profiles e payments já carimbam updated_at nos seus próprios
-- triggers-guarda; aqui ficam só as tabelas que não têm guarda.
create trigger t_pets before update on pets             for each row execute function touch_updated_at();
create trigger t_loc  before update on walker_locations for each row execute function touch_updated_at();

-- =============================================================================
-- 14. PERMISSÕES — o app só lê
--
-- Toda escrita acontece pelas funções RPC de 0002_rpc.sql.
-- =============================================================================

revoke all on all tables in schema public from anon, authenticated;

grant select on profiles, walker_profiles, pets, service_requests,
                payments, refunds, reviews, pricing, terms,
                key_custody, incidents, events
  to authenticated;

-- profiles e pets precisam de insert/update do próprio dono no Épico 1 e 2;
-- os triggers-guarda acima já impedem escalonamento de papel.
grant insert, update on profiles        to authenticated;
grant insert, update on walker_profiles to authenticated;
grant insert, update on pets            to authenticated;
grant insert, update on walker_locations to authenticated;

-- O service_role (Edge Functions) escreve em tudo. No Supabase hospedado ele já
-- nasce com estes privilégios; repetidos aqui para o schema subir sozinho em
-- qualquer Postgres.
grant all      on all tables    in schema public to service_role;
grant all      on all sequences in schema public to service_role;
grant execute  on all functions in schema public to service_role;

-- =============================================================================
-- 15. ROW LEVEL SECURITY
-- =============================================================================

alter table profiles         enable row level security;
alter table walker_profiles  enable row level security;
alter table pets             enable row level security;
alter table service_requests enable row level security;
alter table payments         enable row level security;
alter table payment_events   enable row level security;
alter table refunds          enable row level security;
alter table reviews          enable row level security;
alter table walker_locations enable row level security;
alter table pricing          enable row level security;
alter table terms            enable row level security;
alter table key_custody      enable row level security;
alter table incidents        enable row level security;
alter table events           enable row level security;

-- profiles ------------------------------------------------------------------
create policy p_sel_own    on profiles for select using (id = (select auth.uid()) or is_admin());
create policy p_ins_own    on profiles for insert with check (id = (select auth.uid()) and role <> 'admin');
create policy p_upd_own    on profiles for update using (id = (select auth.uid()))
                                            with check (id = (select auth.uid()));

-- walker_profiles: a vitrine pública é a view walkers_public, não a tabela.
create policy wp_sel_own on walker_profiles for select
  using (user_id = (select auth.uid()) or is_admin());
create policy wp_ins_own on walker_profiles for insert
  with check (user_id = (select auth.uid()) and my_role() = 'walker');
create policy wp_upd_own on walker_profiles for update
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- pets ----------------------------------------------------------------------
create policy pets_own on pets for select
  using (owner_id = (select auth.uid()) or is_admin());
create policy pets_ins on pets for insert with check (owner_id = (select auth.uid()));
create policy pets_upd on pets for update
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
-- O walker lê os dados do animal pelo pet_snapshot da solicitação, não daqui.

-- service_requests: LEITURA apenas. Escrita é só via RPC.
create policy sr_sel_client on service_requests for select
  using (client_id = (select auth.uid()));
create policy sr_sel_walker on service_requests for select
  using (walker_id = (select auth.uid()));
create policy sr_sel_admin  on service_requests for select using (is_admin());
-- Pedidos abertos NÃO são lidos direto da tabela: o walker os recebe pela
-- função open_requests_for_walker(), que devolve bairro e não endereço exato.

-- payments ------------------------------------------------------------------
create policy pay_sel on payments for select using (
  exists (select 1 from service_requests sr
           where sr.id = payments.request_id
             and (sr.client_id = (select auth.uid()) or sr.walker_id = (select auth.uid())))
  or is_admin()
);
-- payment_events: ninguém além do servidor. Sem policy alguma.

create policy ref_sel on refunds for select using (
  exists (select 1 from payments p join service_requests sr on sr.id = p.request_id
           where p.id = refunds.payment_id
             and (sr.client_id = (select auth.uid()) or sr.walker_id = (select auth.uid())))
  or is_admin()
);

-- reviews: leitura pública entre usuários autenticados; escrita via RPC.
create policy rev_sel on reviews for select to authenticated using (true);

-- walker_locations: cada walker só enxerga a própria posição.
create policy loc_own on walker_locations for select
  using (walker_id = (select auth.uid()) or is_admin());
create policy loc_ins on walker_locations for insert
  with check (walker_id = (select auth.uid()));
create policy loc_upd on walker_locations for update
  using (walker_id = (select auth.uid())) with check (walker_id = (select auth.uid()));

-- pricing e terms: leitura para quem está logado.
create policy pricing_sel on pricing for select to authenticated using (true);
create policy terms_sel   on terms   for select to authenticated using (true);

-- key_custody e incidents: só as partes envolvidas.
create policy kc_sel on key_custody for select
  using (client_id = (select auth.uid()) or walker_id = (select auth.uid()) or is_admin());

create policy inc_sel on incidents for select using (
  exists (select 1 from service_requests sr
           where sr.id = incidents.request_id
             and (sr.client_id = (select auth.uid()) or sr.walker_id = (select auth.uid())))
  or is_admin()
);

-- events: cada um vê o histórico do que lhe diz respeito.
create policy ev_sel on events for select using (
  actor_id = (select auth.uid())
  or is_admin()
  or (entity = 'service_request' and exists (
        select 1 from service_requests sr
         where sr.id = events.entity_id
           and (sr.client_id = (select auth.uid()) or sr.walker_id = (select auth.uid()))))
);
