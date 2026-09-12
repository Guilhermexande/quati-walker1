# ADR-001 — Decisões de arquitetura do Quati Walker

**Data:** 11/09/2026 · **Status:** aceito · **Decisores:** Guilherme, Diógenes

Este documento trava as decisões. Código que contraria algo aqui está errado — ou o
documento precisa ser atualizado primeiro, com uma nova entrada explicando por quê.

---

## Contexto

Plataforma de intermediação de serviços pet em Foz do Iguaçu/PR. A plataforma não presta
o serviço: aproxima tutor e walker, processa o pagamento e retém 20% de comissão.

Restrições reais que moldaram tudo abaixo:

- **Equipe de duas pessoas**, uma só programando, ~5h por semana cada.
- **App completo antes de vender** (decisão do Guilherme, 11/09/2026). Não haverá operação
  manual para descobrir problemas antes — logo, as regras precisam estar certas no papel.
- **PIX é o único meio de pagamento.** PIX não tem pré-autorização nem captura em duas
  etapas. Isso é a raiz das decisões 3 e 4.

---

## Decisão 1 — Duas espécies, dois serviços

**Cão → passeio. Gato → visita em casa.**

Gato não passeia. Aceitar gato obriga o sistema a ter mais de um tipo de serviço desde o
primeiro dia.

**Consequências no código:**

- A tabela é `service_requests`, **nunca** `walk_requests`.
- A tabela de animais é `pets` com coluna `species`, **nunca** `dogs`.
- `service_type` é `walk | visit` e a combinação com a espécie é validada por trigger no
  banco (`assert_service_matches_species`), não só na tela.

**Fora do escopo, e isto é deliberado:** hospedagem, adestramento, banho e tosa,
transporte veterinário.

---

## Decisão 2 — Preço e comissão vivem no banco, nunca no app

Existe a tabela `pricing`, versionada por `active_from` / `active_to`. O app pergunta o
preço ao servidor; nunca o calcula.

**Por quê:** mudar de R$ 40 para R$ 45 não pode exigir uma nova versão na App Store. Com
atualização por loja, metade dos usuários ficaria dias com o preço velho — e um app que
calcula o próprio preço é adulterável.

**Consequências:**

- `service_requests` guarda um **snapshot**: `price_cents`, `commission_cents`,
  `payout_cents` e o `pricing_id` que originou. Mudança de preço **nunca** retroage.
- A constraint `split_fecha` garante `price = commission + payout` em toda linha.
- Valores iniciais: R$ 40,00 · 2000 bps (20%) · R$ 32,00 ao walker.

---

## Decisão 3 — Walker aceita primeiro, cliente paga em 10 minutos

```
requested → walker aceita → reserved (TTL 10 min) → cliente paga → confirmed
                                  ↓ não pagou
                               expired  (walker volta a ficar disponível)
```

**Alternativa rejeitada:** cliente paga antes de qualquer walker aceitar. Geraria reembolso
sempre que ninguém aceitasse, e reembolso de PIX é atrito puro — o cliente pagou e não teve
serviço nenhum.

**Por que 10 minutos:** é o tempo de abrir o app do banco e pagar um PIX, sem deixar o
walker travado por muito tempo. É um parâmetro, não uma verdade — revisar depois dos
primeiros 50 serviços.

**Anti-abuso:** cliente que deixa 3 reservas expirarem em 30 dias passa a pagar antes do
aceite. Implementado pela view `clients_pay_first`.

**Operacional:** `expire_stale_reservations()` precisa rodar no `pg_cron` **a cada minuto**.
Sem esse agendamento, reservas ficam presas e walkers somem do pool. É o ponto de falha
silencioso mais provável de todo o sistema.

---

## Decisão 4 — Política de cancelamento, escrita antes de existir o problema

| Situação | Cliente recebe de volta | Walker recebe |
|---|---|---|
| Cliente cancela com 2h ou mais de antecedência | 100% | R$ 0 |
| Cliente cancela com menos de 2h | 50% | R$ 16 |
| Cliente ausente, após 15 min de espera | 0% | R$ 32 |
| Walker cancela ou não comparece | 100% | R$ 0 |
| Caso fortuito (temporal, alagamento, doença) | 100% | R$ 0 |

Implementado em `cancellation_split()`, no banco — não na tela. O resultado é gravado em
`refund_cents` e `final_payout_cents` na própria solicitação, para ficar auditável.

O mesmo texto está nos Termos de Uso v1.0, seção 7. **Os dois precisam mudar juntos.**

---

## Decisão 5 — Split nativo do Mercado Pago, não repasse manual

O cliente paga R$ 40. O Mercado Pago deposita R$ 32 na conta do walker e R$ 8 na da
plataforma, via `application_fee`.

**Alternativa rejeitada:** receber os R$ 40 e repassar R$ 32 manualmente. Isso é
movimentar dinheiro de terceiro — traz obrigação contábil, float no caixa e trabalho
operacional diário, sem nenhum ganho.

**Consequências:**

- `walker_profiles.mp_user_id` é **obrigatório** para o walker receber solicitações.
- O Access Token do Mercado Pago vive **só** em Edge Function. Nunca no app, nunca no
  repositório.
- `payments` tem `idempotency_key` única e índice único de um pagamento aprovado por
  solicitação. Webhook do MP reenvia o mesmo evento — o banco é quem impede a duplicidade.
- A nota fiscal da plataforma é sobre a **comissão de R$ 8,00** — ver decisão 9.

---

## Decisão 6 — Segurança pelo banco (RLS), não pela tela

Toda tabela tem Row Level Security. A regra de quem vê o quê está no Postgres, não no
código do app.

**Por quê:** o app é código que roda no celular do usuário. Qualquer um com um proxy fala
direto com a API. Se a regra só existe na tela, ela não existe.

**Pontos não óbvios das políticas:**

- `payments` **não tem policy de insert nem update.** Só a `service_role`, dentro de Edge
  Function, escreve pagamento. Cliente e walker apenas leem.
- `walker_locations` não é legível por clientes. Eles chamam `walkers_for_request()`, que
  devolve distância, nunca coordenada. Localização de pessoa não vaza.
- O walker só enxerga os dados do animal (`pets`) depois de aceitar o serviço.
- `pricing` é de leitura pública e escrita só pelo servidor.

---

## Decisão 7 — Ordem de construção: pagamento antes do mapa

```
Épico 0  schema + ADR       ← este documento
Épico 1  auth e perfis
Épico 2  animais (cão e gato)
Épico 3  solicitação + aceite dos Termos
Épico 5  PIX + webhook          ← trocado de posição
Épico 4  matching geoespacial   ← trocado de posição
Épico 6  execução do serviço
Épico 7  comissão e repasse
Épico 8  avaliações e histórico
```

**Por que 5 antes de 4:** o pagamento é o núcleo do negócio e a integração de maior risco —
é onde aparecem webhook duplicado, timeout, ambiente de sandbox diferente do de produção.
Descobrir isso no mês 2 é barato; no mês 6 é caro.

O matching geoespacial é **otimização**. Enquanto não existir, uma lista dos walkers do
bairro resolve — e com 5 walkers em Foz, resolve bem.

---

## Decisão 8 — Aceite dos Termos pertence à solicitação, não ao cadastro

`service_requests` guarda `terms_version` e `terms_accepted_at` em cada linha.

**Por quê:** se os Termos mudarem, é preciso provar qual texto valia **naquele** serviço.
Aceite guardado no cadastro do usuário não responde a essa pergunta, e é exatamente a
pergunta que aparece quando há um incidente.

---

## Decisão 9 — A nota fiscal é sobre a comissão, não sobre o serviço

**Decidido por Guilherme em 11/09/2026.**

A plataforma fatura **R$ 8,00** — o valor da intermediação. Não fatura os R$ 40,00.

**Por quê:** faturar os R$ 40 significaria que a plataforma vende o serviço de passeio, o que a
tornaria a prestadora perante o cliente — com a responsabilidade e a carga tributária inteiras
sobre um valor que, na maior parte, nem fica com ela. Imposto sobre R$ 40 come a comissão.

**Consequências, e elas são reais:**

- O prestador perante o tutor é o **walker**, não a plataforma. Isso precisa estar escrito nos
  Termos — e já está, seção 2.
- O split do Mercado Pago deixa de ser conveniência e passa a ser **exigência do modelo**: o
  dinheiro do walker não pode transitar pela conta da plataforma, ou o desenho fiscal desmonta.
- O schema precisa de campos que hoje não existem: documento fiscal da comissão, dados fiscais
  do walker, relatório mensal para o contador.
- Muda o recrutamento: pode ser que o walker precise ser MEI. Isso é pergunta para o contador,
  e afeta quantas pessoas em Foz conseguem se cadastrar.

## Decisão 10 — Nenhum SQL dentro do aplicativo

**Decidido por Guilherme em 11/09/2026.**

O app nunca escreve SQL nem monta query. Ele chama operações nomeadas com parâmetros — e a
regra de negócio vive inteira no servidor.

**Por quê:** query montada no cliente amarra o app ao schema. Renomear uma coluna passaria a
exigir nova versão na loja, e metade dos usuários ficaria com um app quebrado por dias. Além
disso, tudo que o app decide, o usuário pode alterar.

**Onde cada coisa mora** — detalhado em `docs/camada-de-dados.md`.

---

## O que este documento NÃO decide

Fica registrado para não parecer esquecimento:

1. **Enquadramento fiscal.** MEI provavelmente não cobre intermediação com retenção de
   comissão. Precisa de contador **antes** de abrir o CNPJ.
2. **Seguro.** A v1 não tem cobertura para o animal, o walker ou terceiros. Está declarado
   nos Termos, seção 11. Contratar apólice quando o volume justificar.
3. **Verificação de antecedentes do walker.** Hoje só existe `verified_at`, preenchido à
   mão depois de conferir documento. Sem processo formal.
4. **Rastreamento em segundo plano durante o passeio.** Segunda fase.
5. **Chat dentro do app.** Segunda fase; por ora, telefone.

---

## Referências

- Termos de Uso e Política de Privacidade v1.0 — https://claude.ai/code/artifact/ceb3b41d-e21e-4442-8284-5b07f56ed81c
- Quadro do projeto — https://trello.com/b/TaAGHaFE/quatiwalker
- Schema — `supabase/migrations/0001_schema.sql`
- Máquina de estados — `docs/maquina-de-estados.md`
