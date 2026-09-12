# Stack, estrutura do app e camada de dados

Complementa o ADR-001. Aqui está o **como**: qual stack, como o projeto é organizado
e por onde o app fala com o banco sem escrever SQL.

---

## A stack

| Camada | Escolha | Por que esta |
|---|---|---|
| App | **Expo SDK 54 + React Native, expo-router** | Um código para Android e iOS. Roteamento por arquivo, igual ao Next. Atualização OTA sem passar na loja. |
| Linguagem | **TypeScript estrito** | O compilador é o revisor que você não tem. |
| Estado de servidor | **TanStack Query** | Cache, revalidação, repetição automática e estado de carregamento prontos. Resolve sozinho metade dos casos de sinal ruim. |
| Estado local | **Zustand** | Sessão e rascunhos. Leve, sem cerimônia. |
| Cliente do banco | **supabase-js**, usado **só** para `.rpc()` e `.from().select()` | Escrita nunca sai da RPC. |
| Tipos | **`supabase gen types typescript`** | Os tipos das funções RPC saem do banco. Renomear coluna quebra a build, não o app do usuário. |
| Formulários | **react-hook-form + zod** | O mesmo esquema zod valida na tela e descreve o parâmetro da RPC. |
| Backend | **Supabase**: Postgres + PostGIS + RLS + Edge Functions (Deno) | Auth, banco, storage e funções num lugar só. Nível gratuito generoso. |
| Pagamento | **Mercado Pago PIX com split** (`application_fee`) | Exigência do modelo fiscal (ADR decisão 9). |
| Push | **expo-notifications** | Integrado ao Expo, sem servidor próprio. |
| Mapa | **react-native-maps** | Só na tela do walker. O cliente vê faixa de distância, não mapa. |
| Erros | **Sentry** | Sem isso, você descobre o bug pelo WhatsApp do cliente. |
| Build | **EAS Build + EAS Update** | Build na nuvem, correção publicada em minutos. |

### O que foi descartado, e por quê

| Descartado | Motivo |
|---|---|
| Backend próprio (Node/Nest + Docker) | Mais uma coisa para hospedar, monitorar e pagar. Um dev a 5h/semana não sustenta. |
| Flutter | Ótimo framework. Mas jogaria fora o TypeScript que você já usa e o ecossistema Supabase/Expo. |
| Firebase | Sem PostGIS e sem SQL. O matching por proximidade e as travas de integridade que sustentam o dinheiro deste projeto não existiriam. |
| Redux Toolkit | Cerimônia demais para o tamanho do app. |
| PWA em vez de app nativo | Push confiável no iOS ainda é frágil, e o walker precisa de push. |

---

## A regra do SQL

```
┌──────────────┐   rpc('accept_request', {…})   ┌─────────────────┐
│   APP        │ ─────────────────────────────► │  FUNÇÃO RPC     │
│ (celular)    │                                │  (Postgres)     │
│              │ ◄───────────────────────────── │  valida, grava, │
│  só LÊ       │        select via RLS          │  carimba        │
└──────────────┘                                └─────────────────┘
```

O app tem **permissão de leitura**. Toda escrita passa por uma função com nome.

**O que isso resolve:**

- Renomear uma coluna não quebra o app de ninguém — a assinatura da função continua igual.
- A regra de negócio existe num lugar só, e é o lugar que o usuário não controla.
- A auditoria que reprovou a versão 1.0 encontrou 29 problemas críticos. Vinte e um deles
  eram variações de "o app escreve direto na tabela".

---

## As operações, uma a uma

### Cliente

| Chamada | O que faz | Cuidado embutido |
|---|---|---|
| `create_service_request` | cria o pedido | Preço **não é parâmetro** — vem de `pricing`. Valida dono do animal, vacina em dia, horário no futuro, e bloqueia quem tem 3 reservas expiradas. |
| `cancel_request` | cancela | O split de reembolso é calculado pelo trigger, não pelo app. |
| `submit_review` | avalia | Só serviço concluído, só o cliente daquele serviço, só até 30 dias. |
| `walkers_for_request` | quem está perto | Devolve **faixa** de distância, nunca metros exatos. |

### Walker

| Chamada | O que faz | Cuidado embutido |
|---|---|---|
| `open_requests_for_walker` | pedidos por perto | Devolve **bairro e faixa**, nunca o endereço. O endereço só aparece depois do aceite. Esconde pedidos que colidem com a agenda dele. |
| `accept_request` | aceita | `where status = 'requested'` é a trava da corrida: o segundo walker afeta zero linhas e recebe "já foi aceito". |
| `start_service` / `finish_service` | inicia e encerra | Grava a posição. Sem isso, "o passeio não aconteceu" é indecidível. |
| `walker_cancel` | desiste | Cliente recebe 100%. |
| `report_no_show` | tutor não apareceu | Só depois de 15 minutos do horário. |
| `set_availability` | fica disponível | Disponibilidade **vence**. Quem fechou o app para de receber pedido. |

### Só o servidor (Edge Function, `service_role`)

| Chamada | Onde mora |
|---|---|
| `create_pix_charge` | Edge Function — precisa do token do Mercado Pago |
| `server_register_payment` | RPC, chamada pela Edge Function |
| `server_apply_payment_event` | RPC — idempotente por `mp_event_id`; devolve `estornar` se o PIX cair depois de a reserva expirar |

---

## Estrutura de pastas

```
quati-walker/
├── app/                          expo-router: cada arquivo é uma tela
│   ├── (auth)/                   login, cadastro, escolha de papel
│   ├── (client)/                 pets, novo pedido, pagamento, acompanhar, avaliar
│   ├── (walker)/                 disponibilidade, pedidos, serviço em andamento, ganhos
│   └── _layout.tsx               decide (client) ou (walker) pelo papel
│
├── src/
│   ├── api/                      ÚNICO lugar que fala com o Supabase
│   │   ├── client.ts             cliente supabase-js
│   │   ├── requests.ts           create/cancel/accept/start/finish
│   │   ├── walkers.ts            disponibilidade e pedidos abertos
│   │   ├── payments.ts           cobrança e status
│   │   └── types.gen.ts          GERADO — nunca editar à mão
│   ├── hooks/                    useCreateRequest, useOpenRequests…
│   ├── components/
│   ├── stores/                   sessão, rascunho de pedido
│   ├── lib/                      formatação de dinheiro, data, distância
│   └── schemas/                  zod: valida na tela e descreve a RPC
│
├── supabase/
│   ├── migrations/               0001_schema.sql · 0002_rpc.sql
│   ├── functions/                Edge Functions (Deno)
│   │   ├── create-pix-charge/
│   │   └── mp-webhook/
│   └── seed.sql
│
├── docs/                         ADR-001 · máquina de estados · este arquivo
└── tests/
```

**A regra da pasta `api/`:** nenhum componente importa `supabase` diretamente. Se um `import`
do supabase aparecer fora de `src/api/`, é bug de arquitetura. Vale uma regra de lint.

---

## Quando o sinal cai

O walker está na rua. É o caso normal, não a exceção.

| Situação | Solução |
|---|---|
| Encerrar o serviço sem sinal | Fila local (MMKV) + repetição com recuo. A RPC é idempotente: repetir não duplica. |
| Esperando o PIX cair | Realtime do Supabase na linha do pedido, com polling a cada 5s como rede de proteção. O prazo é o `reserved_until` do servidor. |
| App fechado no meio do pagamento | Ao reabrir, lê o status do servidor. O estado vive no banco, não na tela. |
| Dois walkers aceitam junto | O segundo recebe `hint: ja_aceito` e volta para a lista, já atualizada. |
| Relógio do celular errado | **Nada** depende da hora do aparelho. Todo carimbo é `now()` do Postgres. |
| Bateria | Posição a cada 2 minutos enquanto disponível; a cada 30 segundos durante o serviço. |

---

## Testes: o mínimo que protege dinheiro

Não dá para testar tudo com 5h por semana. Dá para testar o que custa caro.

1. **Máquina de estados** (pgTAP ou SQL puro): toda transição inválida levanta exceção.
2. **Dinheiro**: cada linha da tabela de cancelamento vira um teste. `price = refund + comissão + repasse`, sempre.
3. **Webhook**: evento duplicado, fora de ordem, e PIX que cai depois de expirar.
4. **RLS**: com o token do cliente A, tentar ler e escrever os dados de B — em cada tabela.
5. **Corrida do aceite**: duas transações simultâneas, uma vence.

O resto é teste manual. Tudo bem.

---

## Publicar nas lojas

| Exigência | O que fazer |
|---|---|
| Conta de desenvolvedor | Apple US$ 99/ano, Google US$ 25 uma vez. Ambas pedem CNPJ para app de serviço. |
| Pagamento fora da loja | PIX por serviço **físico** está liberado nas duas. Não é compra dentro do app. |
| Permissão de localização | Justificativa escrita na ficha da loja. É o motivo nº 1 de reprovação. |
| Exclusão de conta | Obrigatória dentro do app desde 2022. Resolvida por `anonymize_profile()`. |
| Política de privacidade | URL pública obrigatória. Já existe. |
| Idade mínima | Declarar 18+. |

---

## Custo mensal real

| Item | Custo |
|---|---|
| Supabase Free | R$ 0 até ~500 MB e 50 mil usuários ativos |
| Supabase Pro (quando crescer) | ~US$ 25 |
| EAS Build | gratuito no início |
| Apple | US$ 99/ano ≈ R$ 45/mês |
| Google | US$ 25, uma vez |
| Sentry | gratuito no início |
| Mercado Pago PIX | ~0,99% por transação, descontado da sua comissão |

**No começo: ~R$ 50/mês.** Com comissão de R$ 8, a conta fecha em **7 serviços por mês**.

---

## Horas por épico

Para um desenvolvedor, a 5h por semana.

| Épico | Horas | Semanas |
|---|---|---|
| 0 · schema + RPC + ADR | ✅ feito | — |
| 1 · auth e perfis | 25 | 5 |
| 2 · animais | 20 | 4 |
| 3 · solicitação + termos | 30 | 6 |
| 5 · PIX + webhook | 45 | 9 |
| 4 · matching | 25 | 5 |
| 6 · execução | 35 | 7 |
| 7 · comissão e repasse | 25 | 5 |
| 8 · avaliações | 20 | 4 |
| publicação nas lojas | 25 | 5 |
| **Total** | **250 h** | **~50 semanas** |

Cerca de **um ano** a 5h/semana. Se o Diógenes assumir as tarefas de mundo real e você
conseguir 10h em algumas semanas, cai para 7 ou 8 meses.

O caminho mais curto para encurtar isso não é programar mais rápido: é cortar escopo.
Os épicos 4 e 8 podem esperar o app já estar rodando — são 45 horas.
