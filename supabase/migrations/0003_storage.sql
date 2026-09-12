-- =============================================================================
-- Quati Walker — fotos dos animais (Storage)
-- Épico 2 · Versão 1.0 — 12/09/2026
--
-- UMA REGRA ORGANIZA O ARQUIVO INTEIRO: o caminho é a permissão.
--
--     pet-photos / <owner_id> / <pet_id>.jpg
--                  ────┬─────
--                      └── tem que ser igual a auth.uid()
--
-- storage.foldername('<owner_id>/<pet_id>.jpg') devolve {<owner_id>}, e toda
-- policy abaixo compara esse primeiro elemento com quem está pedindo. Ninguém
-- escreve nem lê dentro da pasta de outra pessoa.
--
-- src/api/storage.ts monta exatamente este caminho e guarda a string devolvida
-- em pets.photo_path. A convenção vive nos dois lugares: mudá-la de um lado só
-- derruba o upload e o acesso do walker ao mesmo tempo.
-- =============================================================================

-- =============================================================================
-- 1. O BUCKET
-- =============================================================================

-- PRIVADO. Foto de animal é foto de dentro da casa de alguém: aparece o portão,
-- a sala, a criança ao fundo. Em bucket público a URL não expira nunca e quem a
-- descobrir uma vez a tem para sempre — aqui o app pede uma URL assinada, de
-- validade curta, no instante de exibir.
--
-- O upsert existe porque o bucket pode já ter sido criado à mão no painel: neste
-- caso o que vale é a configuração deste arquivo, não a do clique.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pet-photos', 'pet-photos', false,
        2 * 1024 * 1024,       -- o app reduz a imagem antes de subir; 2 MB é folga
        array['image/jpeg'])   -- uma extensão só: mantém o caminho previsível
on conflict (id) do update
   set public             = excluded.public,
       file_size_limit    = excluded.file_size_limit,
       allowed_mime_types = excluded.allowed_mime_types;

-- No Supabase hospedado a RLS de storage.objects já vem ligada e a tabela
-- pertence a supabase_storage_admin — um ALTER incondicional falharia por falta
-- de dono. No Postgres dos testes (tests/00_stub_supabase.sql) ela nasce
-- desligada, e sem este bloco as policies abaixo não valeriam nada.
do $$
begin
  if not exists (
    select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'storage' and c.relname = 'objects' and c.relrowsecurity
  ) then
    execute 'alter table storage.objects enable row level security';
  end if;
end $$;

-- =============================================================================
-- 2. O DONO DO ANIMAL
--
-- Quatro policies, uma por operação: no Postgres uma policy `for all` também
-- valeria, mas aí insert, select, update e delete passam a ser a mesma decisão —
-- e restringir só um deles depois exigiria reescrever os quatro.
-- =============================================================================

create policy pet_photos_ins on storage.objects for insert to authenticated
  with check (
    bucket_id = 'pet-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy pet_photos_sel on storage.objects for select to authenticated
  using (
    bucket_id = 'pet-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Trocar a foto é subir por cima do mesmo caminho. O `with check` repete a
-- condição do `using` porque sem ele o update aceitaria mover o arquivo para
-- dentro da pasta de outra pessoa.
create policy pet_photos_upd on storage.objects for update to authenticated
  using (
    bucket_id = 'pet-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'pet-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Apagar a IMAGEM é do tutor. Apagar o ANIMAL não existe: o registro sai de cena
-- por pets.archived_at, porque service_requests.pet_id é `on delete restrict` e
-- um DELETE levaria o histórico do serviço junto.
create policy pet_photos_del on storage.objects for delete to authenticated
  using (
    bucket_id = 'pet-photos'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- =============================================================================
-- 3. O WALKER DO SERVIÇO
--
-- A foto NÃO vai no pet_snapshot: snapshot guarda dado, e imagem embutida em
-- jsonb inflaria toda linha de service_requests para sempre, sem nunca poder ser
-- descartada. O walker recebe acesso de leitura ao arquivo — e só enquanto o
-- serviço daquele animal lhe pertence.
-- =============================================================================

-- SECURITY DEFINER pelo mesmo motivo de walkers_for_request(): a consulta
-- precisa ler uma linha de `pets` que a RLS esconde do walker (pets_own libera
-- só o dono). Dentro de uma policy, esse exists() rodaria como o walker e
-- voltaria sempre vazio — a foto não apareceria para ninguém.
create or replace function walker_may_read_pet_photo(p_object_name text)
returns boolean
language sql stable security definer set search_path = pg_catalog, public, extensions as $$
  select exists (
    select 1
      from public.pets p
      join public.service_requests sr on sr.pet_id = p.id
     -- photo_path é a fonte da verdade sobre qual arquivo é deste animal: quando
     -- o tutor troca a foto, o acesso do walker acompanha sozinho.
     where p.photo_path = p_object_name
       and sr.walker_id = (select auth.uid())
       and sr.status in ('reserved', 'confirmed', 'in_progress', 'completed')
  );
$$;

revoke execute on function walker_may_read_pet_photo(text) from public;
grant  execute on function walker_may_read_pet_photo(text) to authenticated;

-- 'requested' fica de fora: enquanto ninguém aceitou, não há walker — e um
-- pedido aberto é visível a vários. 'completed' fica dentro porque serviço
-- encerrado ainda vira incidente, e aí o walker precisa mostrar de que animal se
-- tratava. Cancelado e expirado cortam o acesso na hora.
create policy pet_photos_walker_sel on storage.objects for select to authenticated
  using (
    bucket_id = 'pet-photos'
    and public.walker_may_read_pet_photo(name)
  );

-- A policy acima procura em `pets` pelo caminho do arquivo, uma vez por objeto
-- consultado. Sem índice, é varredura da tabela a cada foto exibida na tela do
-- walker.
create index pets_photo_path_idx on pets (photo_path) where photo_path is not null;

-- =============================================================================
-- 4. NOTAS DE OPERAÇÃO
--
-- · Os privilégios de tabela em storage.objects (select/insert/update/delete
--   para `authenticated`) já vêm prontos no Supabase hospedado; nos testes quem
--   os concede é tests/00_stub_supabase.sql. Não são recriados aqui para a
--   migration não depender de ser dona de um schema que é do Storage.
--
-- · anonymize_profile() zera pets.photo_path, mas não apaga o arquivo — o
--   Postgres não alcança o objeto. A remoção física é tarefa do servidor, e com
--   photo_path nulo nenhuma policy deste arquivo devolve mais aquele objeto.
-- =============================================================================
