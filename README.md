# Quati Walker

Plataforma de intermediação de serviços pet em Foz do Iguaçu/PR.

**Cão → passeio · Gato → visita em casa.** R$ 40 o serviço, 20% de comissão, pagamento
só por PIX com split no Mercado Pago.

---

## Estado do projeto

| Épico | O que é | Situação |
|---|---|---|
| 0 | Schema + RPC + ADR + auditoria | ✅ feito |
| 1 | Autenticação e perfis | ✅ feito |
| 2 | Cadastro de animais (cão e gato) | ✅ feito |
| 3 | Solicitação de serviço + aceite dos Termos | ⬜ |
| 5 | PIX via Mercado Pago + webhook | ⬜ |
| 4 | Matching geoespacial (PostGIS) | ⬜ |
| 6 | Execução do serviço | ⬜ |
| 7 | Comissão e repasse | ⬜ |
| 8 | Avaliações e histórico | ⬜ |

Quadro: https://trello.com/b/TaAGHaFE/quatiwalker

---

## Rodar o app

```bash
npm install --legacy-peer-deps
cp .env.example .env      # preencha com os dados do seu projeto Supabase
npx expo start
```

Verificado em 12/09/2026: `tsc --noEmit` sem erro e `expo export` empacotando
1115 módulos. O app ainda não foi aberto num aparelho — falta um projeto
Supabase de verdade para o login funcionar.

> `--legacy-peer-deps` é necessário hoje: `react-dom@19.3` conflita com o
> `react@19.1` que o SDK 54 fixa. Não afeta o app, que não usa react-dom.

### O que ficou pendente do Épico 1

Achados da revisão que não foram aplicados, em ordem de importância:

- o botão "Criar minha conta" aceita dois toques seguidos e empilha duas telas;
- `walker-setup` fica sem saída enquanto o salvamento falha;
- queda de rede entre entrar e buscar o perfil deixa a pessoa logada numa tela de erro;
- a tela de nova senha (o link do e-mail) não existe — hoje só o envio.

### O que ficou pendente do Épico 2

Dos 25 achados das duas revisões, o crítico e todos os altos foram aplicados.
Ficaram de fora:

- o aviso da vacina em `pets/[id].tsx` usa os mesmos tokens do `ErrorBanner`,
  então dois blocos vermelhos diferentes convivem na mesma tela;
- a borda das linhas de escolha mede 2,99:1 sobre `surface` no tema escuro —
  único ponto do épico abaixo de 3:1 (o texto todo passa com folga).

Um cuidado que não é dívida, mas se perde fácil: o caminho do arquivo no bucket
é `<owner_id>/<pet_id>.jpg`, montado em `src/api/storage.ts` e conferido pela
policy da `0003_storage.sql`. Mudar a convenção de um lado sem mudar do outro
não dá erro — a foto simplesmente some para o passeador. `tests/02_storage.sql`
é o que avisa.

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
bash scripts/db-test.sh
```

Esperado no fim: `TODOS OS TESTES PASSARAM` e `TESTES DE STORAGE PASSARAM`.
**Verificado em 12/09/2026: 18/18 de fumaça + 8/8 de storage.**

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
