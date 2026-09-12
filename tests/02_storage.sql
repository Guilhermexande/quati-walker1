-- =============================================================================
-- Quati Walker — testes das policies da foto do animal
--
-- Prova a única pergunta que a 0003_storage.sql existe para responder:
-- QUEM PODE VER A FOTO DE QUEM.
--
-- É a parte do épico 2 que o TypeScript não alcança. Um erro aqui não quebra a
-- tela nem aparece no `tsc`: ou a foto some para quem deveria vê-la, ou — pior —
-- a foto do animal dentro da casa de alguém fica legível para um estranho.
--
-- Carregar DEPOIS do 01_smoke (usa a semente dele: os walkers, o pricing e os
-- termos). Os ids daqui começam com 'b' para não esbarrar nos de lá.
--
-- Como rodar:
--   bash scripts/db-test.sh
--
-- Qualquer FALHOU aborta o script.
-- =============================================================================

\set ON_ERROR_STOP on
set client_min_messages to notice;

-- =============================================================================
-- SEMENTE
--
-- Uma tutora com um cão, e o caminho da foto no formato que src/api/storage.ts
-- monta: '<owner_id>/<pet_id>.jpg'. Se essa convenção mudar no aplicativo sem
-- mudar aqui, este arquivo é o que avisa.
-- =============================================================================

insert into auth.users (id, email) values
  ('bbbbbbbb-1111-1111-1111-111111111111', 'tutora.foto@teste.br');

insert into profiles (id, role, full_name, phone_e164, email) values
  ('bbbbbbbb-1111-1111-1111-111111111111', 'client', 'Tutora da Foto',
   '+5545999990011', 'tutora.foto@teste.br');

insert into pets (id, owner_id, name, species, size, rabies_valid_until) values
  ('bbbbbbbb-2222-2222-2222-222222222222', 'bbbbbbbb-1111-1111-1111-111111111111',
   'Lupi', 'dog', 'medium', current_date + 180);

insert into storage.objects (bucket_id, name, owner)
values ('pet-photos',
        'bbbbbbbb-1111-1111-1111-111111111111/bbbbbbbb-2222-2222-2222-222222222222.jpg',
        'bbbbbbbb-1111-1111-1111-111111111111');

-- =============================================================================
-- 1. O bucket é privado
--
-- Bucket público dispensa assinatura: qualquer pessoa com o endereço abre a
-- foto, para sempre, mesmo depois de o serviço acabar.
-- =============================================================================
do $$
declare pub boolean;
begin
  select public into pub from storage.buckets where id = 'pet-photos';
  if pub is null    then raise exception 'FALHOU 1: bucket pet-photos não existe'; end if;
  if pub            then raise exception 'FALHOU 1: bucket está público'; end if;
  raise notice 'PASS 1 · bucket pet-photos existe e é privado';
end $$;

-- =============================================================================
-- 2. A dona grava na pasta dela
-- =============================================================================
do $$
declare n integer;
begin
  perform test_as('bbbbbbbb-1111-1111-1111-111111111111');

  insert into storage.objects (bucket_id, name, owner)
  values ('pet-photos',
          'bbbbbbbb-1111-1111-1111-111111111111/outro-animal.jpg',
          'bbbbbbbb-1111-1111-1111-111111111111');

  select count(*) into n from storage.objects
   where name = 'bbbbbbbb-1111-1111-1111-111111111111/outro-animal.jpg';
  reset role;

  if n <> 1 then raise exception 'FALHOU 2: a dona não conseguiu gravar na própria pasta'; end if;
  raise notice 'PASS 2 · a dona grava na pasta dela';
end $$;

-- =============================================================================
-- 3. Na pasta de outra pessoa, não
--
-- O caminho é a autorização: quem escolhe o nome do arquivo escolhe a pasta, e
-- sem esta recusa bastaria montar o caminho com o id alheio.
-- =============================================================================
do $$
begin
  perform test_as('bbbbbbbb-1111-1111-1111-111111111111');
  begin
    insert into storage.objects (bucket_id, name, owner)
    values ('pet-photos',
            '11111111-1111-1111-1111-111111111111/invadido.jpg',
            'bbbbbbbb-1111-1111-1111-111111111111');
    reset role;
    raise exception 'FALHOU 3: gravou na pasta de outra pessoa';
  exception when insufficient_privilege then
    reset role;
    raise notice 'PASS 3 · gravar na pasta alheia é recusado';
  end;
end $$;

-- =============================================================================
-- 4. Um walker sem serviço com este animal não vê a foto
--
-- Atenção ao que se mede: RLS que barra pelo USING não estoura exceção — ela
-- devolve zero linha, em silêncio. Um teste que esperasse erro passaria mesmo
-- com a policy escancarada.
-- =============================================================================
do $$
declare n integer;
begin
  perform test_as('22222222-2222-2222-2222-222222222222');
  select count(*) into n from storage.objects
   where name = 'bbbbbbbb-1111-1111-1111-111111111111/bbbbbbbb-2222-2222-2222-222222222222.jpg';
  reset role;

  if n <> 0 then raise exception 'FALHOU 4: walker sem serviço enxergou a foto'; end if;
  raise notice 'PASS 4 · walker sem serviço não vê a foto';
end $$;

-- =============================================================================
-- 5. Com o serviço aceito, o walker passa a ver
--
-- E só quando `pets.photo_path` aponta para o arquivo: o vínculo é o caminho
-- gravado na linha do animal, não a convenção de nome remontada na policy.
-- =============================================================================
do $$
declare v_req uuid; n integer;
begin
  perform test_as('bbbbbbbb-1111-1111-1111-111111111111');
  v_req := create_service_request(
    'bbbbbbbb-2222-2222-2222-222222222222', 'walk', 60,
    'Rua da Foto, 10', -25.5163, -54.5854, now() + interval '30 hours');
  reset role;

  perform test_as('22222222-2222-2222-2222-222222222222');
  perform accept_request(v_req);
  reset role;

  -- Ainda sem photo_path gravado: o arquivo está no bucket, mas nada diz que
  -- ele é a foto deste animal.
  perform test_as('22222222-2222-2222-2222-222222222222');
  select count(*) into n from storage.objects
   where name = 'bbbbbbbb-1111-1111-1111-111111111111/bbbbbbbb-2222-2222-2222-222222222222.jpg';
  reset role;

  if n <> 0 then raise exception 'FALHOU 5: viu a foto sem photo_path gravado'; end if;

  perform test_as('bbbbbbbb-1111-1111-1111-111111111111');
  update pets
     set photo_path = 'bbbbbbbb-1111-1111-1111-111111111111/bbbbbbbb-2222-2222-2222-222222222222.jpg'
   where id = 'bbbbbbbb-2222-2222-2222-222222222222';
  reset role;

  perform test_as('22222222-2222-2222-2222-222222222222');
  select count(*) into n from storage.objects
   where name = 'bbbbbbbb-1111-1111-1111-111111111111/bbbbbbbb-2222-2222-2222-222222222222.jpg';
  reset role;

  if n <> 1 then raise exception 'FALHOU 5: walker do serviço não vê a foto'; end if;
  raise notice 'PASS 5 · o walker do serviço vê a foto, e só depois de photo_path gravado';
end $$;

-- =============================================================================
-- 6. Ver não é mexer
--
-- O walker lê o arquivo do serviço dele. Sobrescrever a foto do animal de um
-- cliente, não — e aqui a medida é `row_count`, não exceção.
-- =============================================================================
do $$
declare n integer;
begin
  perform test_as('22222222-2222-2222-2222-222222222222');

  update storage.objects set owner = '22222222-2222-2222-2222-222222222222'
   where name = 'bbbbbbbb-1111-1111-1111-111111111111/bbbbbbbb-2222-2222-2222-222222222222.jpg';
  get diagnostics n = row_count;
  if n <> 0 then reset role; raise exception 'FALHOU 6: walker alterou o arquivo (% linha)', n; end if;

  delete from storage.objects
   where name = 'bbbbbbbb-1111-1111-1111-111111111111/bbbbbbbb-2222-2222-2222-222222222222.jpg';
  get diagnostics n = row_count;
  reset role;
  if n <> 0 then raise exception 'FALHOU 6: walker apagou o arquivo (% linha)', n; end if;

  raise notice 'PASS 6 · o walker lê, mas não altera nem apaga a foto';
end $$;

-- =============================================================================
-- 7. Cancelou, perde o acesso no mesmo instante
--
-- 'reserved', 'confirmed', 'in_progress' e 'completed' liberam. Cancelado e
-- expirado cortam — o acesso acompanha o estado do serviço, não o histórico.
-- =============================================================================
do $$
declare v_req uuid; n integer;
begin
  select id into v_req from service_requests
   where pet_id = 'bbbbbbbb-2222-2222-2222-222222222222'
   order by created_at desc limit 1;

  perform test_as('bbbbbbbb-1111-1111-1111-111111111111');
  perform cancel_request(v_req);
  reset role;

  perform test_as('22222222-2222-2222-2222-222222222222');
  select count(*) into n from storage.objects
   where name = 'bbbbbbbb-1111-1111-1111-111111111111/bbbbbbbb-2222-2222-2222-222222222222.jpg';
  reset role;

  if n <> 0 then raise exception 'FALHOU 7: walker continuou vendo a foto após o cancelamento'; end if;
  raise notice 'PASS 7 · cancelado, o walker perde o acesso à foto';
end $$;

-- =============================================================================
-- 8. A dona zera photo_path e a foto some para o walker
--
-- É o mesmo caminho pelo qual a troca de foto funciona sozinha: o acesso segue
-- o que está gravado na linha do animal, e não um nome montado por convenção.
-- =============================================================================
do $$
declare v_req uuid; n integer;
begin
  perform test_as('bbbbbbbb-1111-1111-1111-111111111111');
  v_req := create_service_request(
    'bbbbbbbb-2222-2222-2222-222222222222', 'walk', 60,
    'Rua da Foto, 10', -25.5163, -54.5854, now() + interval '50 hours');
  reset role;

  perform test_as('22222222-2222-2222-2222-222222222222');
  perform accept_request(v_req);
  select count(*) into n from storage.objects
   where name = 'bbbbbbbb-1111-1111-1111-111111111111/bbbbbbbb-2222-2222-2222-222222222222.jpg';
  reset role;
  if n <> 1 then raise exception 'FALHOU 8: o walker deveria estar vendo a foto'; end if;

  perform test_as('bbbbbbbb-1111-1111-1111-111111111111');
  update pets set photo_path = null where id = 'bbbbbbbb-2222-2222-2222-222222222222';
  reset role;

  perform test_as('22222222-2222-2222-2222-222222222222');
  select count(*) into n from storage.objects
   where name = 'bbbbbbbb-1111-1111-1111-111111111111/bbbbbbbb-2222-2222-2222-222222222222.jpg';
  reset role;

  if n <> 0 then raise exception 'FALHOU 8: a foto continuou visível depois de zerar photo_path'; end if;

  -- E o animal continua lá: tirar a foto não é remover o cadastro.
  if not exists (select 1 from pets where id = 'bbbbbbbb-2222-2222-2222-222222222222'
                   and archived_at is null)
    then raise exception 'FALHOU 8: o animal sumiu junto com a foto'; end if;

  raise notice 'PASS 8 · zerar photo_path corta o acesso, e o animal continua cadastrado';
end $$;

-- =============================================================================
select 'TESTES DE STORAGE PASSARAM' as resultado;
