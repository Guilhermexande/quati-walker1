# Quati Walker

Plataforma de intermediação de serviços pet em Foz do Iguaçu/PR.

**Cão → passeio · Gato → visita em casa.** R$ 40 o serviço, 20% de comissão, pagamento
só por PIX com split no Mercado Pago.

---

## Estado do projeto

| Épico | O que é | Situação |
|---|---|---|
| 0 | Schema + RPC + ADR + auditoria | ✅ feito |
| 1 | Autenticação e perfis | ⬜ próximo |
| 2 | Cadastro de animais (cão e gato) | ⬜ |
| 3 | Solicitação de serviço + aceite dos Termos | ⬜ |
| 5 | PIX via Mercado Pago + webhook | ⬜ |
| 4 | Matching geoespacial (PostGIS) | ⬜ |
| 6 | Execução do serviço | ⬜ |
| 7 | Comissão e repasse | ⬜ |
| 8 | Avaliações e histórico | ⬜ |

Quadro: https://trello.com/b/TaAGHaFE/quatiwalker

---

## Documentos

| Arquivo | Para quê |
|---|---|
| `docs/ADR-001-decisoes.md` | **Leia primeiro.** As 10 decisões travadas e o porquê de cada uma. |
| `docs/camada-de-dados.md` | Stack, estrutura de pastas, a API entre app e banco, custos e horas. |
| `docs/maquina-de-estados.md` | Os 8 estados do serviço e quem dispara cada transição. |
| `docs/auditoria-schema-v1.md` | Os 85 problemas encontrados na v1.0 e o que mudou na v2.0. |
| `supabase/migrations/0001_schema.sql` | Tabelas, triggers, constraints, RLS. |
| `supabase/migrations/0002_rpc.sql` | **A API do app.** Toda escrita passa por aqui. |
| [Termos de Uso v1.0](https://claude.ai/code/artifact/ceb3b41d-e21e-4442-8284-5b07f56ed81c) | Minuta. As regras do ADR e dos Termos mudam juntas. |

---

## Rodar o banco localmente

O jeito rápido, sem a pilha inteira do Supabase — só um Postgres com PostGIS:

```bash
docker run -d --name quati-db -e POSTGRES_PASSWORD=quati -e POSTGRES_DB=quati -p 5433:5432 postgis/postgis:15-3.4
```

Carregar e testar (o `-i` com redirecionamento evita `docker cp`, que embaralha
caminho no Git Bash do Windows):

```bash
for f in tests/00_stub_supabase.sql supabase/migrations/0001_schema.sql supabase/migrations/0002_rpc.sql tests/01_smoke.sql; do docker exec -i quati-db psql -U postgres -d quati -v ON_ERROR_STOP=1 -q < "$f"; done
```

Esperado no fim: `TODOS OS TESTES PASSARAM`. **Verificado em 12/09/2026: 18/18.**

Para recomeçar do zero:

```bash
docker exec quati-db psql -U postgres -d postgres -c "drop database quati;" -c "create database quati;"
```

O `tests/00_stub_supabase.sql` recria o schema `auth`, a função `auth.uid()` e os
papéis `anon` / `authenticated` / `service_role`. No Supabase hospedado nada disso
é necessário — carregue só as duas migrations.

Alternativa com a pilha completa (precisa de mais disco e de Docker com
privilégio): `npx supabase init && npx supabase start && npx supabase db reset`.

Depois, agendar o job que expira reservas — **sem ele o sistema trava em silêncio**:

```sql
select cron.schedule('expira-pedidos', '* * * * *',
                     $$ select expire_stale_requests() $$);
```

Gerar os tipos do app a partir do banco:

```bash
npx supabase gen types typescript --local > src/api/types.gen.ts
```

---

## Quatro regras que não se quebram

1. **O app não escreve SQL.** Ele chama funções RPC por nome. Se um `import` do supabase
   aparecer fora de `src/api/`, é bug de arquitetura.
2. **O app nunca calcula preço nem comissão.** Vem da tabela `pricing`, pelo servidor.
3. **O Access Token do Mercado Pago só existe em Edge Function.** Nunca no app, nunca no repositório.
4. **Autorização mora no banco.** Regra que só existe na tela não existe.
