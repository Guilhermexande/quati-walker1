-- =============================================================================
-- Quati Walker — testes de fumaça
--
-- Provam as duas coisas que custam caro se estiverem erradas:
--   1. o dinheiro fecha
--   2. ninguém pula etapa da máquina de estados
--
-- Como rodar (precisa de um Postgres com PostGIS):
--   bash scripts/db-test.sh
--
-- Ou à mão, nesta ordem:
--   psql "$URL" -v ON_ERROR_STOP=1 \
--     -f tests/00_stub_supabase.sql \
--     -f supabase/migrations/0001_schema.sql \
--     -f supabase/migrations/0002_rpc.sql \
--     -f supabase/migrations/0003_storage.sql \
--     -f tests/01_smoke.sql \
--     -f tests/02_storage.sql
--
-- Qualquer FALHOU aborta o script. Silêncio no fim = tudo passou.
-- =============================================================================

\set ON_ERROR_STOP on
set client_min_messages to notice;

-- =============================================================================
-- SEMENTE
-- =============================================================================

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'tutor@teste.br'),
  ('22222222-2222-2222-2222-222222222222', 'walker1@teste.br'),
  ('33333333-3333-3333-3333-333333333333', 'walker2@teste.br');

insert into profiles (id, role, full_name, phone_e164, email, cpf_digits) values
  ('11111111-1111-1111-1111-111111111111', 'client', 'Tutor Teste',   '+5545999990001', 'tutor@teste.br',   null),
  ('22222222-2222-2222-2222-222222222222', 'walker', 'Walker Um',     '+5545999990002', 'walker1@teste.br', '11144477735'),
  ('33333333-3333-3333-3333-333333333333', 'walker', 'Walker Dois',   '+5545999990003', 'walker2@teste.br', '52998224725');

insert into walker_profiles (user_id, radius_m, accepts_dog, accepts_large_dog, mp_user_id, verified_at) values
  ('22222222-2222-2222-2222-222222222222', 10000, true, true, 'MP-1', now()),
  ('33333333-3333-3333-3333-333333333333', 10000, true, true, 'MP-2', now());

-- Cataratas do Iguaçu como referência; os dois walkers a poucos metros do tutor.
insert into walker_locations (walker_id, geog, available, available_until) values
  ('22222222-2222-2222-2222-222222222222', st_setsrid(st_makepoint(-54.5854, -25.5163), 4326), true, now() + interval '4 hours'),
  ('33333333-3333-3333-3333-333333333333', st_setsrid(st_makepoint(-54.5860, -25.5170), 4326), true, now() + interval '4 hours');

insert into pets (id, owner_id, name, species, size, rabies_valid_until) values
  ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
   'Thor', 'dog', 'large', current_date + 180),
  ('aaaaaaaa-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111',
   'Mia', 'cat', null, current_date + 180),
  -- cão com vacina vencida, para o teste 3
  ('aaaaaaaa-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111',
   'Bidu', 'dog', 'small', current_date - 10);

-- =============================================================================
-- 1. O preço vem do servidor, e o split fecha
-- =============================================================================
do $$
declare v_id uuid; r service_requests;
begin
  perform test_as('11111111-1111-1111-1111-111111111111');
  v_id := create_service_request(
    'aaaaaaaa-0000-0000-0000-000000000001', 'walk', 60,
    'Rua Teste, 100', -25.5163, -54.5854, now() + interval '3 hours');
  reset role;

  select * into r from service_requests where id = v_id;

  if r.price_cents <> 4000      then raise exception 'FALHOU 1: preço % ≠ 4000', r.price_cents; end if;
  if r.commission_cents <> 800  then raise exception 'FALHOU 1: comissão % ≠ 800', r.commission_cents; end if;
  if r.payout_cents <> 3200     then raise exception 'FALHOU 1: repasse % ≠ 3200', r.payout_cents; end if;
  if r.status <> 'requested'    then raise exception 'FALHOU 1: status %', r.status; end if;
  if r.terms_version is null    then raise exception 'FALHOU 1: sem versão dos termos'; end if;
  if r.pet_snapshot->>'name' <> 'Thor' then raise exception 'FALHOU 1: snapshot do animal vazio'; end if;

  raise notice 'PASS 1 · preço 4000 = 800 + 3200, vindo da tabela pricing';
end $$;

-- =============================================================================
-- 2. Gato não passeia
-- =============================================================================
do $$
begin
  perform test_as('11111111-1111-1111-1111-111111111111');
  begin
    perform create_service_request('aaaaaaaa-0000-0000-0000-000000000002', 'walk', 60,
                                   'Rua Teste, 100', -25.5163, -54.5854, now() + interval '3 hours');
    reset role;
    raise exception 'FALHOU 2: aceitou passeio com gato';
  exception when others then
    reset role;
    if sqlerrm like 'FALHOU%' then raise; end if;
    raise notice 'PASS 2 · gato recusado para passeio (%)', sqlerrm;
  end;
end $$;

-- =============================================================================
-- 3. Vacina antirrábica vencida bloqueia o pedido (Termos §8)
-- =============================================================================
do $$
begin
  perform test_as('11111111-1111-1111-1111-111111111111');
  begin
    perform create_service_request('aaaaaaaa-0000-0000-0000-000000000003', 'walk', 60,
                                   'Rua Teste, 100', -25.5163, -54.5854, now() + interval '3 hours');
    reset role;
    raise exception 'FALHOU 3: aceitou animal com vacina vencida';
  exception when others then
    reset role;
    if sqlerrm like 'FALHOU%' then raise; end if;
    raise notice 'PASS 3 · vacina vencida recusada (%)', sqlerrm;
  end;
end $$;

-- =============================================================================
-- 4. O app não escreve na tabela — nem para nascer 'completed'
--    (era o pior furo da versão 1.0)
-- =============================================================================
do $$
begin
  perform test_as('11111111-1111-1111-1111-111111111111');
  begin
    insert into service_requests
      (client_id, pet_id, service, duration_minutes, address_text, address_geog,
       scheduled_at, status, pricing_id, price_cents, commission_cents, payout_cents,
       pet_snapshot, terms_version, terms_accepted_at)
    values
      ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-0000-0000-0000-000000000001',
       'walk', 60, 'Rua Teste', st_setsrid(st_makepoint(-54.5854,-25.5163),4326),
       now() + interval '3 hours', 'completed',
       (select id from pricing limit 1), 1, 0, 1, '{}'::jsonb, '1.0', now());
    reset role;
    raise exception 'FALHOU 4: o app conseguiu inserir direto na tabela';
  exception when others then
    reset role;
    if sqlerrm like 'FALHOU%' then raise; end if;
    raise notice 'PASS 4 · INSERT direto negado ao app (%)', sqlerrm;
  end;
end $$;

-- =============================================================================
-- 5. O cliente não confirma o próprio serviço
-- =============================================================================
do $$
declare v_id uuid;
begin
  select id into v_id from service_requests where status = 'requested' limit 1;
  perform test_as('11111111-1111-1111-1111-111111111111');
  begin
    update service_requests set status = 'confirmed' where id = v_id;
    reset role;
    raise exception 'FALHOU 5: cliente confirmou o próprio serviço sem pagar';
  exception when others then
    reset role;
    if sqlerrm like 'FALHOU%' then raise; end if;
    raise notice 'PASS 5 · UPDATE direto negado ao app (%)', sqlerrm;
  end;
end $$;

-- =============================================================================
-- 6. Escalonamento de papel: ninguém vira admin
-- =============================================================================
do $$
declare v_role user_role;
begin
  perform test_as('11111111-1111-1111-1111-111111111111');
  begin
    update profiles set role = 'admin' where id = '11111111-1111-1111-1111-111111111111';
  exception when others then null;   -- pode falhar por policy; o que importa é o resultado
  end;
  reset role;

  select role into v_role from profiles where id = '11111111-1111-1111-1111-111111111111';
  if v_role <> 'client' then raise exception 'FALHOU 6: virou %', v_role; end if;
  raise notice 'PASS 6 · papel continua client';
end $$;

-- =============================================================================
-- 7. Walker aceita; o segundo perde a corrida
-- =============================================================================
do $$
declare v_id uuid; v_until timestamptz; r service_requests;
begin
  select id into v_id from service_requests where status = 'requested' order by created_at limit 1;

  perform test_as('22222222-2222-2222-2222-222222222222');
  v_until := accept_request(v_id);
  reset role;

  select * into r from service_requests where id = v_id;
  if r.status <> 'reserved' then raise exception 'FALHOU 7: status %', r.status; end if;
  if r.walker_id <> '22222222-2222-2222-2222-222222222222' then raise exception 'FALHOU 7: walker errado'; end if;
  if v_until < now() + interval '9 minutes' or v_until > now() + interval '11 minutes' then
    raise exception 'FALHOU 7: reserved_until fora da janela de 10 min (%)', v_until;
  end if;
  raise notice 'PASS 7 · reservado por 10 minutos para o walker 1';

  perform test_as('33333333-3333-3333-3333-333333333333');
  begin
    perform accept_request(v_id);
    reset role;
    raise exception 'FALHOU 7b: segundo walker também aceitou';
  exception when others then
    reset role;
    if sqlerrm like 'FALHOU%' then raise; end if;
    raise notice 'PASS 7b · segundo walker recusado (%)', sqlerrm;
  end;
end $$;

-- =============================================================================
-- 8. Não dá para pular etapa: reserved -> completed é inválido
-- =============================================================================
do $$
declare v_id uuid;
begin
  select id into v_id from service_requests where status = 'reserved' limit 1;
  begin
    update service_requests set status = 'completed' where id = v_id;
    raise exception 'FALHOU 8: pulou de reserved direto para completed';
  exception when others then
    if sqlerrm like 'FALHOU%' then raise; end if;
    raise notice 'PASS 8 · transição reserved -> completed recusada (%)', sqlerrm;
  end;
end $$;

-- =============================================================================
-- 9. Pagamento com valor divergente é recusado
-- =============================================================================
do $$
declare v_id uuid;
begin
  select id into v_id from service_requests where status = 'reserved' limit 1;
  set local role service_role;
  begin
    insert into payments (request_id, idempotency_key, amount_cents, fee_cents)
    values (v_id, 'chave-fraude', 100, 800);
    reset role;
    raise exception 'FALHOU 9: aceitou pagamento de R$ 1,00 para serviço de R$ 40,00';
  exception when others then
    reset role;
    if sqlerrm like 'FALHOU%' then raise; end if;
    raise notice 'PASS 9 · valor divergente recusado (%)', sqlerrm;
  end;
end $$;

-- =============================================================================
-- 10. Webhook: confirma, é idempotente, e não retrocede
-- =============================================================================
do $$
declare v_id uuid; v_pay uuid; v_res text; r service_requests; p payments;
begin
  select id into v_id from service_requests where status = 'reserved' limit 1;

  set local role service_role;
  v_pay := server_register_payment(v_id, 'idem-1', 'MP-PAY-1', 'qr', 'qr64', now() + interval '30 minutes');
  v_res := server_apply_payment_event('EV-1', 'MP-PAY-1', 'approved', '{"x":1}'::jsonb);
  reset role;

  if v_res <> 'confirmado' then raise exception 'FALHOU 10: retorno % ', v_res; end if;
  select * into r from service_requests where id = v_id;
  if r.status <> 'confirmed' then raise exception 'FALHOU 10: status %', r.status; end if;
  raise notice 'PASS 10 · pagamento aprovado confirmou o serviço';

  set local role service_role;
  v_res := server_apply_payment_event('EV-1', 'MP-PAY-1', 'approved', '{"x":1}'::jsonb);
  reset role;
  if v_res <> 'duplicado' then raise exception 'FALHOU 10b: evento repetido retornou %', v_res; end if;
  raise notice 'PASS 10b · evento repetido ignorado';

  -- evento fora de ordem: 'pending' chegando depois de 'approved'
  set local role service_role;
  v_res := server_apply_payment_event('EV-2', 'MP-PAY-1', 'pending', '{"x":2}'::jsonb);
  reset role;
  select * into p from payments where id = v_pay;
  if p.status <> 'approved' then raise exception 'FALHOU 10c: pagamento voltou para %', p.status; end if;
  raise notice 'PASS 10c · webhook fora de ordem não rebaixou o pagamento';
end $$;

-- =============================================================================
-- 11. Início, fim e fechamento financeiro
-- =============================================================================
do $$
declare v_id uuid; r service_requests;
begin
  select id into v_id from service_requests where status = 'confirmed' limit 1;

  perform test_as('22222222-2222-2222-2222-222222222222');
  perform start_service(v_id, -25.5163, -54.5854);
  perform finish_service(v_id, -25.5170, -54.5860);
  reset role;

  select * into r from service_requests where id = v_id;
  if r.status <> 'completed'             then raise exception 'FALHOU 11: status %', r.status; end if;
  if r.final_commission_cents <> 800     then raise exception 'FALHOU 11: comissão final %', r.final_commission_cents; end if;
  if r.final_payout_cents <> 3200        then raise exception 'FALHOU 11: repasse final %', r.final_payout_cents; end if;
  if r.start_geog is null or r.end_geog is null then raise exception 'FALHOU 11: sem posição de início/fim'; end if;
  raise notice 'PASS 11 · concluído, comissão final 800 (base da nota fiscal)';
end $$;

-- =============================================================================
-- 12. Avaliação: só o cliente do serviço, e a nota do walker atualiza
-- =============================================================================
do $$
declare v_id uuid; v_avg numeric;
begin
  select id into v_id from service_requests where status = 'completed' limit 1;

  perform test_as('33333333-3333-3333-3333-333333333333');
  begin
    perform submit_review(v_id, 1::smallint, 'nota falsa');
    reset role;
    raise exception 'FALHOU 12: um estranho avaliou o serviço';
  exception when others then
    reset role;
    if sqlerrm like 'FALHOU%' then raise; end if;
    raise notice 'PASS 12 · avaliação de terceiro recusada (%)', sqlerrm;
  end;

  perform test_as('11111111-1111-1111-1111-111111111111');
  perform submit_review(v_id, 5::smallint, 'ótimo passeio');
  reset role;

  select rating_avg into v_avg from walker_profiles
   where user_id = '22222222-2222-2222-2222-222222222222';
  if v_avg is null or v_avg <> 5.00 then raise exception 'FALHOU 12b: média %', v_avg; end if;
  raise notice 'PASS 12b · nota do cliente registrada, média do walker = 5,00';
end $$;

-- =============================================================================
-- 13. A conta do cancelamento de última hora fecha
--     Esperado: devolve 2000, walker fica com 1600, comissão 400. Soma 4000.
-- =============================================================================
do $$
declare v_id uuid; r service_requests;
begin
  perform test_as('11111111-1111-1111-1111-111111111111');
  v_id := create_service_request('aaaaaaaa-0000-0000-0000-000000000001', 'walk', 60,
            'Rua Teste, 100', -25.5163, -54.5854, now() + interval '1 hour');
  reset role;

  perform test_as('22222222-2222-2222-2222-222222222222');
  perform accept_request(v_id);
  reset role;

  set local role service_role;
  perform server_register_payment(v_id, 'idem-2', 'MP-PAY-2', 'qr', 'qr64', now() + interval '30 minutes');
  perform server_apply_payment_event('EV-3', 'MP-PAY-2', 'approved', '{}'::jsonb);
  reset role;

  perform test_as('11111111-1111-1111-1111-111111111111');
  perform cancel_request(v_id, 'mudou de ideia');
  reset role;

  select * into r from service_requests where id = v_id;
  if r.status <> 'cancelled_client'    then raise exception 'FALHOU 13: status %', r.status; end if;
  if r.refund_cents <> 2000            then raise exception 'FALHOU 13: reembolso %', r.refund_cents; end if;
  if r.final_payout_cents <> 1600      then raise exception 'FALHOU 13: repasse %', r.final_payout_cents; end if;
  if r.final_commission_cents <> 400   then raise exception 'FALHOU 13: comissão %', r.final_commission_cents; end if;
  if r.refund_cents + r.final_payout_cents + r.final_commission_cents <> r.price_cents then
    raise exception 'FALHOU 13: a conta não fecha';
  end if;
  raise notice 'PASS 13 · cancelamento -2h: 2000 + 1600 + 400 = 4000';
end $$;

-- =============================================================================
-- 14. Um walker não assume dois serviços no mesmo horário
-- =============================================================================
do $$
declare v_a uuid; v_b uuid; v_quando timestamptz := now() + interval '5 hours';
begin
  perform test_as('11111111-1111-1111-1111-111111111111');
  v_a := create_service_request('aaaaaaaa-0000-0000-0000-000000000001', 'walk', 60,
           'Rua A', -25.5163, -54.5854, v_quando);
  v_b := create_service_request('aaaaaaaa-0000-0000-0000-000000000001', 'walk', 60,
           'Rua B', -25.5163, -54.5854, v_quando + interval '20 minutes');
  reset role;

  perform test_as('22222222-2222-2222-2222-222222222222');
  perform accept_request(v_a);
  begin
    perform accept_request(v_b);
    reset role;
    raise exception 'FALHOU 14: o mesmo walker assumiu dois serviços sobrepostos';
  exception when others then
    reset role;
    if sqlerrm like 'FALHOU%' then raise; end if;
    raise notice 'PASS 14 · sobreposição de agenda recusada (%)', sqlerrm;
  end;
end $$;

-- =============================================================================
-- 15. O walker vê faixa de distância, nunca o endereço, antes de aceitar
-- =============================================================================
do $$
declare n integer; v_faixa text;
begin
  perform test_as('33333333-3333-3333-3333-333333333333');
  select count(*) into n from open_requests_for_walker();
  select distance_bucket into v_faixa from open_requests_for_walker() limit 1;
  reset role;

  if n = 0 then raise exception 'FALHOU 15: o walker não enxerga nenhum pedido aberto'; end if;
  if v_faixa !~ '^(até 1 km|1 a 3 km|3 a 5 km)$' then
    raise exception 'FALHOU 15: distância veio como "%" em vez de faixa', v_faixa;
  end if;
  raise notice 'PASS 15 · % pedido(s) visíveis, distância como faixa ("%"), sem endereço', n, v_faixa;
end $$;

-- =============================================================================
-- 16. O walker não lê a tabela de pedidos que não são dele
-- =============================================================================
do $$
declare n integer;
begin
  perform test_as('33333333-3333-3333-3333-333333333333');
  select count(*) into n from service_requests
   where walker_id is distinct from '33333333-3333-3333-3333-333333333333';
  reset role;

  if n > 0 then raise exception 'FALHOU 16: o walker leu % pedidos alheios pela tabela', n; end if;
  raise notice 'PASS 16 · RLS esconde da tabela os pedidos alheios';
end $$;

-- =============================================================================
-- 17. Expiração de reserva não paga
-- =============================================================================
do $$
declare v_id uuid; n integer; r service_requests;
begin
  perform test_as('11111111-1111-1111-1111-111111111111');
  v_id := create_service_request('aaaaaaaa-0000-0000-0000-000000000001', 'walk', 60,
            'Rua C', -25.5163, -54.5854, now() + interval '8 hours');
  reset role;

  perform test_as('22222222-2222-2222-2222-222222222222');
  perform accept_request(v_id);
  reset role;

  -- Simula o relógio andando 11 minutos. O trigger congela reserved_until de
  -- propósito — nem o servidor reescreve carimbo — então ele sai de cena só
  -- aqui dentro do teste.
  alter table service_requests disable trigger trg_status_transition;
  update service_requests set reserved_until = now() - interval '1 minute' where id = v_id;
  alter table service_requests enable trigger trg_status_transition;

  n := expire_stale_requests();
  select * into r from service_requests where id = v_id;

  if r.status <> 'expired' then raise exception 'FALHOU 17: status % após expirar', r.status; end if;
  raise notice 'PASS 17 · reserva não paga expirou (% linha(s))', n;
end $$;

-- =============================================================================
-- 18. Trilha de eventos: dá para depurar um serviço
-- =============================================================================
do $$
declare n integer;
begin
  select count(*) into n from events where entity = 'service_request';
  if n = 0 then raise exception 'FALHOU 18: nenhum evento registrado'; end if;
  raise notice 'PASS 18 · % eventos na trilha de auditoria', n;
end $$;

-- =============================================================================
select 'TODOS OS TESTES PASSARAM' as resultado;
