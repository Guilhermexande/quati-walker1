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
