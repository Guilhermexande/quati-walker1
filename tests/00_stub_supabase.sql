-- =============================================================================
-- Stub do ambiente Supabase, para validar as migrations num Postgres puro.
--
-- Em produção nada disto é necessário: o Supabase já fornece o schema auth,
-- a função auth.uid() e os papéis anon / authenticated / service_role.
-- Aqui eles são recriados para que `psql -f 0001 -f 0002` rode num container
-- postgis/postgis limpo, sem baixar a pilha inteira do Supabase.
-- =============================================================================

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

-- auth.uid() lê o "sub" do JWT, exatamente como no Supabase.
-- O nullif externo cobre o caso "sem sessão": sem ele, ''::jsonb estoura.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(
           nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub',
         '')::uuid;
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon')          then create role anon          nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role  nologin bypassrls; end if;
end $$;

grant usage on schema public, auth to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;

-- Ajuda dos testes: assume a identidade de um usuário.
create or replace function test_as(p_user uuid, p_role text default 'authenticated')
returns void language plpgsql as $$
begin
  execute format('set local role %I', p_role);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user)::text, true);
end $$;

-- =============================================================================
-- STORAGE — STUB DE TESTE, exigido por supabase/migrations/0003_storage.sql
--
-- ISTO NÃO É O STORAGE DO SUPABASE. É o mínimo para a 0003 carregar num
-- Postgres puro: o schema, as duas tabelas e a função de caminho. Não sobe
-- arquivo, não gera URL assinada, não serve conteúdo. O que dá para testar aqui
-- é só o que interessa — quem consegue inserir e ler qual linha de
-- storage.objects. Em produção o Supabase fornece tudo isto pronto e nada deste
-- bloco roda.
-- =============================================================================

create schema if not exists storage;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text        not null,
  public             boolean     not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Só as colunas que as policies da 0003 leem. A tabela real tem metadata,
-- versão, tamanho e mais meia dúzia de campos do servidor de storage; nada
-- disso muda a decisão de permissão, que é tomada sobre bucket_id e name.
create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text        not null references storage.buckets (id),
  name       text        not null,
  owner      uuid        references auth.users (id),
  metadata   jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint objects_caminho_unico unique (bucket_id, name)
);

-- Mesma semântica da função do Supabase: devolve os diretórios do caminho, sem
-- o nome do arquivo.
--   'uid/pet.jpg' → {uid}
--   'pet.jpg'     → {}  (e {}[1] é null, que numa policy não é verdadeiro —
--                        arquivo solto na raiz fica negado, como deve ser)
create or replace function storage.foldername(name text) returns text[]
language sql immutable as $$
  select (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1];
$$;

-- A RLS de storage.objects NÃO é ligada aqui: quem liga é a 0003, e o container
-- de teste é justamente onde esse caminho do código precisa ser exercitado.
grant usage on schema storage to anon, authenticated, service_role;
grant select on storage.buckets to authenticated, service_role;
grant select, insert, update, delete on storage.objects to authenticated, service_role;
