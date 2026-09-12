export const meta = {
  name: 'quati-epico-3',
  description: 'Épico 3 do Quati Walker: solicitação de serviço + aceite dos Termos',
  phases: [
    { title: 'Base', detail: 'API de pedidos, preço, termos, localização, schemas e hooks' },
    { title: 'Telas', detail: 'lista de pedidos, novo pedido (4 passos), detalhe e cancelamento' },
    { title: 'Revisar', detail: 'consistência técnica e a experiência de quem vai pedir' },
  ],
}

const RAIZ = 'C:\\Users\\guilherme.rocha\\OneDrive - URBIA CATARATAS SA\\Área de Trabalho\\quati-walker'

const CONTEXTO = `
PROJETO: Quati Walker — plataforma de intermediação de serviços pet em Foz do Iguaçu/PR.
Raiz do repositório: ${RAIZ}

LEIA ANTES DE ESCREVER QUALQUER LINHA (nesta ordem):
  docs/ADR-001-decisoes.md          as 10 decisões travadas
  docs/maquina-de-estados.md        os 8 estados do serviço
  supabase/migrations/0002_rpc.sql  A API DO APP — toda escrita passa por aqui
  supabase/migrations/0001_schema.sql  tabelas, triggers, constraints, RLS
  src/api/pets.ts + src/api/profiles.ts   o molde de como se escreve um arquivo de API aqui
  src/hooks/usePets.ts              o molde dos hooks
  app/(client)/pets/novo.tsx        o molde de uma tela de formulário longo
  src/components/ui.tsx             Screen, Title, Body, Button, TextField, LongTextField, ErrorBanner, Loading
  src/lib/theme.ts                  tokens; NUNCA escreva cor literal

AS QUATRO REGRAS QUE NÃO SE QUEBRAM
1. O app não escreve SQL. Ele chama funções RPC por nome. Import do supabase só em src/api/.
2. O app NUNCA calcula preço nem comissão. Vem da tabela pricing, pelo servidor.
3. O Access Token do Mercado Pago só existe em Edge Function.
4. Autorização mora no banco. Regra que só existe na tela não existe.

ESTILO DA CASA (é levado a sério, não é enfeite)
- Português do Brasil em TUDO: nome de variável, comentário, texto de tela.
- Comentário explica POR QUE, nunca O QUE. Comentário que descreve a linha de baixo é ruído.
- Texto de tela escrito para uma tutora de 52 anos em Foz, não para programador.
  Nada de "erro 422", "payload", "caracteres", "token".
- TypeScript strict + noUncheckedIndexedAccess. Zero \`any\`, zero \`!\`, zero \`as\` que minta.
- Toque mínimo 44pt. Contraste mínimo 4.5:1 em texto.
- Nenhum valor em reais escrito em código. Preço vem do banco, sempre.
`

const O_QUE_O_BANCO_JA_FAZ = `
O QUE JÁ EXISTE E FUNCIONA (18 testes de fumaça + 8 de storage, todos verdes)

RPC create_service_request(p_pet_id, p_service, p_duration_min, p_address_text,
                           p_lat, p_lng, p_scheduled_at) returns uuid
  - O trigger assert_request_insert DERIVA preço, comissão e repasse da tabela pricing,
    grava ends_at, tira o snapshot do animal e carimba a versão dos Termos.
    O app manda zero valor em reais.
  - Recusa, com mensagem em português, quando:
      'Gato só aceita visita em casa' / 'Cão só aceita passeio'
      'o animal não pertence a este cliente'
      'animal arquivado'
      'vacina antirrábica vencida ou não informada'
      'o horário precisa estar ao menos 15 minutos no futuro'
      'sem preço vigente para <serviço> / <duração> min'
  - E antes de tudo, se o cliente tem reserva expirada por falta de pagamento nos
    últimos 30 dias, levanta erro com hint = 'pagar_antes'. src/api/client.ts já
    tem AppErrorHint = 'ja_aceito' | 'pagar_antes' | 'sem_mp' | null — USE.

RPC cancel_request(p_request_id, p_reason)
  - Recusa: 'este serviço já está encerrado', 'sem permissão',
    'serviço em andamento não pode ser cancelado; registre um incidente'.
  - O SPLIT DO CANCELAMENTO é calculado pelo trigger assert_status_transition,
    não pelo app: >= 2h antes = 100% de volta; < 2h = metade.
    O app pode MOSTRAR quanto volta, lendo price_cents do próprio pedido.
    Não invente a regra — leia assert_status_transition em 0001_schema.sql.

TABELAS LEGÍVEIS PELO APP (policy select using(true) para authenticated)
  pricing  (service, duration_minutes, price_cents, commission_bps, active_from, active_to)
           A linha vigente é a que tem active_from <= now() e (active_to is null ou > now()).
  terms    (version, body_url, published_at, active)  — uma só com active = true.

service_requests: o cliente lê as próprias linhas (policy sr_sel_client). As colunas
que interessam aqui: id, pet_id, service, duration_minutes, address_text, scheduled_at,
ends_at, status, price_cents, commission_cents, payout_cents, terms_version,
pet_snapshot, walker_id, reserved_until, created_at.
`

const AVISOS = `
OS QUATRO ERROS MAIS PROVÁVEIS DESTE ÉPICO — procure por eles ativamente

1. PREÇO ESCRITO NO APP. "R$ 40", 4000, ou qualquer cálculo de comissão em
   arquivo .ts/.tsx é bug de arquitetura, mesmo que o número esteja certo hoje.
   O preço vem de pricing. Se a consulta falhar, a tela NÃO chuta: ela diz que
   não conseguiu carregar o valor e não deixa pedir.

2. FUSO HORÁRIO. scheduled_at é timestamptz. O seletor devolve um Date local
   (Foz é UTC-3). Converter errado marca o passeio para outra hora sem avisar
   ninguém — e o erro aparece só no dia. Use toISOString() sobre o Date montado
   com os componentes locais, e escreva na tela a hora local de volta para a
   pessoa CONFERIR antes de confirmar.

3. ACEITE DOS TERMOS PRÉ-MARCADO. A caixa nasce desmarcada, sempre. A versão
   aceita é carimbada pelo servidor (terms_version), e a tela precisa MOSTRAR
   qual versão está aceitando e um jeito de ler o texto (terms.body_url).
   Caixa pré-marcada não é aceite — é armadilha.

4. ENDEREÇO SEM COORDENADA. O banco exige lat/lng (address_geog). NÃO existe
   serviço de geocodificação pago neste projeto e não vai existir. Os dois
   caminhos aceitáveis, nesta ordem:
     a) reaproveitar o endereço do último pedido da pessoa (ela lê os próprios
        service_requests; o geog volta como GeoJSON pelo PostgREST);
     b) Location.getCurrentPositionAsync() do expo-location, com a pessoa
        confirmando "estou no endereço do serviço agora".
   Location.geocodeAsync pode ser tentado como conveniência, mas NUNCA como
   único caminho: no Android sem chave do Google ele volta vazio em silêncio.
   Se não houver coordenada, o botão de confirmar não fica disponível — e a
   tela explica por quê, em português de gente.
`

const CONTRATO = `
CONTRATO DO ÉPICO 3 — respeite os nomes, outros agentes estão escrevendo contra eles

src/api/pricing.ts
  export type Pricing = { id, service, durationMinutes, priceCents, commissionBps }
  export async function precoVigente(service: 'walk'|'visit', duracaoMin: number): Promise<Pricing | null>

src/api/terms.ts
  export type Terms = { version: string; bodyUrl: string | null; publishedAt: string }
  export async function termosAtivos(): Promise<Terms | null>

src/api/requests.ts
  export type ServiceRequest  (linha de service_requests, tipada de types.gen)
  export type RequestInput = { petId, service, duracaoMin, enderecoTexto, lat, lng, quando: string }
  export async function createRequest(input: RequestInput): Promise<string>   // devolve o id
  export async function cancelRequest(id: string, motivo?: string): Promise<void>
  export async function listMyRequests(): Promise<ServiceRequest[]>
  export async function getRequest(id: string): Promise<ServiceRequest | null>
  export async function ultimoEndereco(): Promise<{ texto: string; lat: number; lng: number } | null>

src/lib/localizacao.ts
  export type Coordenada = { lat: number; lng: number }
  export async function minhaLocalizacao(): Promise<Coordenada>   // erra com AppError legível
  export async function coordenadaDoEndereco(texto: string): Promise<Coordenada | null>

src/schemas/request.ts
  export const requestSchema
  export function servicoDoAnimal(species: 'dog'|'cat'): 'walk'|'visit'
  export function nomeDoServico(service: 'walk'|'visit'): string      // "passeio" / "visita em casa"
  export function descricaoDoStatus(status): { titulo: string; explicacao: string }
  export function podeCancelar(status): boolean
  export function reembolsoSeCancelarAgora(priceCents: number, scheduledAt: string):
    { centavos: number; explicacao: string }
  export function reais(centavos: number): string                     // "R$ 40,00"

src/hooks/useRequests.ts
  useMyRequests, useRequest(id), useCreateRequest, useCancelRequest,
  usePrecoVigente(service, duracaoMin), useTermosAtivos, useUltimoEndereco

app/(client)/pedidos/index.tsx   lista dos meus pedidos + estado vazio
app/(client)/pedidos/novo.tsx    o pedido, em passos: animal → quando → onde → conferir e aceitar
app/(client)/pedidos/[id].tsx    o pedido por dentro + cancelar

E o botão de entrada em app/(client)/inicio.tsx, ao lado do que já leva aos animais.
`

const REGRAS_DE_ARQUIVO = `
COMO TRABALHAR
- Escreva SOMENTE os arquivos que a sua tarefa nomeia. Não toque em nenhum outro.
- Não altere 0001_schema.sql, 0002_rpc.sql, 0003_storage.sql nem os testes.
- Rode \`npx tsc --noEmit\` e deixe limpo antes de terminar. Se não der para deixar
  limpo por causa de arquivo de outro agente, DIGA ISSO no resumo.
- Arquivo temporário de verificação: apague antes de terminar.
- Devolva { arquivos: string[], resumo: string, duvidas: string }.
  Em \`duvidas\`, numere as decisões que você tomou e que alguém pode querer rever.
  Se você inventou uma regra de negócio que não está no ADR, DIGA — em letras garrafais.
`

const base = [
  {
    key: 'preco-termos',
    prompt: `Escreva src/api/pricing.ts, src/api/terms.ts e src/lib/localizacao.ts.

São os três arquivos que trazem para o app coisas que ele não pode inventar:
o preço, a versão dos Termos e a coordenada do endereço.

pricing.ts: precoVigente() consulta a tabela pricing filtrando pela janela de
vigência. Devolve null quando não há preço para aquele serviço/duração — e QUEM
CHAMA precisa conseguir distinguir "não tem preço" de "não consegui falar com o
servidor", porque a tela reage diferente nos dois casos. Pense nisso na assinatura.

terms.ts: termosAtivos() lê a linha com active = true. body_url pode ser nulo
(hoje a minuta é um link externo); a tela precisa saber lidar com isso.

localizacao.ts: minhaLocalizacao() pede a permissão NO MOMENTO DO TOQUE, nunca
na abertura da tela, e traduz cada recusa do sistema para uma frase em português
que diga o que fazer a seguir (permissão negada / negada para sempre / GPS
desligado / demorou demais). coordenadaDoEndereco() usa Location.geocodeAsync e
devolve null quando não acha — sem estourar, porque no Android ele volta vazio
com frequência e isso não é erro, é o normal.

LEIA src/api/storage.ts antes: ele é o exemplo mais próximo de como este projeto
trata erro de biblioteca nativa e o traduz para a tela.`,
  },
  {
    key: 'api-pedidos',
    prompt: `Escreva src/api/requests.ts e src/schemas/request.ts.

requests.ts é a camada sobre as RPCs create_service_request e cancel_request.
Leia as duas em 0002_rpc.sql com atenção antes de escrever uma linha: elas já
validam quase tudo, e o seu trabalho é traduzir o erro delas para uma frase que
a tutora entenda, no mesmo espírito do readable() de src/api/pets.ts.

Casos que EXIGEM texto próprio (não podem chegar crus na tela):
  - hint = 'pagar_antes'  → ela tem reserva expirada por falta de pagamento
  - 'vacina antirrábica vencida ou não informada' → dizer QUAL animal e que o
    conserto é no cadastro dele
  - 'o horário precisa estar ao menos 15 minutos no futuro'
  - 'sem preço vigente' → não é culpa dela; é a plataforma que está sem tabela

ultimoEndereco() lê o service_request mais recente da própria pessoa para
reaproveitar endereço e coordenada. ATENÇÃO: address_geog é geography; pelo
PostgREST ele volta como GeoJSON, e a ordem dos números em GeoJSON é
[longitude, latitude] — trocada em relação a como quase todo mundo fala.
Trocar os dois põe o passeio no meio do oceano Índico sem nenhum erro aparecer.
Confira isso de verdade contra o banco, não só de cabeça.

request.ts: o zod do formulário mais as funções de texto. reembolsoSeCancelarAgora()
tem que ESPELHAR assert_status_transition do 0001_schema.sql, não uma regra que
você lembre — leia o trigger e copie a lógica. Se a sua conta divergir da do
banco, a tela promete um valor que não vai acontecer.`,
  },
  {
    key: 'hooks',
    prompt: `Escreva src/hooks/useRequests.ts.

Siga src/hooks/usePets.ts como molde — chaves de cache, invalidação, o que é
query e o que é mutation.

Três coisas que só existem neste épico e precisam de decisão consciente:

1. Depois de criar um pedido, o que invalida? A lista de pedidos, claro. Mas
   pense também em quem mais mostra contagem ou estado na tela inicial.

2. usePrecoVigente é uma consulta que a tela usa para DECIDIR se deixa pedir.
   Enquanto ela não resolve, o botão de confirmar não pode estar disponível —
   e isso é responsabilidade da tela, mas o hook tem que deixar isso possível
   de ler sem ginástica.

3. A lista de pedidos muda por fora do app: um passeador aceita e o estado vira
   'reserved'. Não existe tempo real neste épico. Escolha o staleTime pensando
   em quem abriu a lista às 8h e está olhando para ela às 8h30, e explique a
   escolha no comentário.`,
  },
]

const telas = [
  {
    key: 'lista',
    prompt: `Escreva app/(client)/pedidos/index.tsx — a lista dos meus pedidos.

Cada linha responde, sem a pessoa precisar tocar: qual animal, qual serviço,
que dia e hora, e EM QUE PÉ ESTÁ. O estado é o que ela abriu o app para ver.

Os oito estados vêm de docs/maquina-de-estados.md. 'requested' é "ninguém pegou
ainda" — e é o estado em que ela vai passar mais tempo olhando, então ele
precisa de um texto que não a deixe ansiosa nem minta sobre prazo.

Estado vazio: quem nunca pediu nada. Leva para o cadastro de animal se ela ainda
não tem nenhum, e para o pedido se já tem — são situações diferentes e o texto
tem que ser diferente.

Siga app/(client)/pets/index.tsx: mesmo formato de cartão tocável (com a seta),
mesmo RefreshControl, e a mesma regra de rolagem — FlatList não mora dentro de
ScrollView, então o estado vazio e o de erro usam <Screen scroll> e a lista não.`,
  },
  {
    key: 'novo',
    prompt: `Escreva app/(client)/pedidos/novo.tsx — o pedido, do começo ao fim.

É a tela mais importante do aplicativo: é aqui que entra dinheiro.

Quatro passos, um de cada vez na tela, com o caminho de volta sempre visível:

1. QUAL ANIMAL — lista os animais dela (useMyPets). A espécie decide o serviço
   e ela não escolhe: cão vira passeio, gato vira visita em casa. Diga isso na
   linha do animal, não num aviso depois.
   Animal com antirrábica vencida aparece, mas não dá para escolher — com o
   motivo escrito e um caminho direto para o cadastro dele. Descobrir isso aqui
   é ruim; descobrir depois de preencher tudo é pior.
   Sem animal nenhum: manda cadastrar, e não deixa seguir.

2. QUANDO — data e hora. @react-native-community/datetimepicker já está
   instalado. O banco exige 15 minutos de folga; a tela não deve deixar chegar
   perto disso — escolha uma folga confortável e explique a escolha no comentário.
   Mostre de volta, por extenso, o dia e a hora que ela escolheu. É a única
   defesa contra erro de fuso, e o custo de errar é ela não estar em casa.

3. ONDE — o endereço do serviço. Se houver endereço de pedido anterior
   (useUltimoEndereco), ofereça reaproveitar em um toque. Senão, ela usa a
   localização do aparelho estando no lugar, ou digita e o app tenta achar.
   Sem coordenada, não dá para confirmar — e a tela precisa explicar isso de um
   jeito que não pareça defeito.

4. CONFERIR E ACEITAR — o resumo inteiro, o VALOR VINDO DO BANCO (nunca do
   código), e o aceite dos Termos numa caixa que nasce desmarcada, com a versão
   à vista e um jeito de ler o texto. Só então o botão de confirmar.
   Diga, antes do toque, o que acontece depois: o pedido fica aberto para os
   passeadores da região, alguém aceita, e o pagamento vem em seguida (o PIX é
   o Épico 5 — não prometa tela que não existe).

Use o passo-a-passo de app/(client)/pets/novo.tsx como referência de estrutura e
de tom. Toda mensagem de erro vem pronta da camada de API — não reescreva aqui.`,
  },
  {
    key: 'detalhe',
    prompt: `Escreva app/(client)/pedidos/[id].tsx — o pedido por dentro, e o cancelamento.

Mostra tudo o que foi combinado: animal (do pet_snapshot, que é o que vale — não
do cadastro atual, que pode ter mudado depois), serviço, dia e hora, endereço,
valor, versão dos Termos aceita, e o estado com explicação.

O CANCELAMENTO é a parte delicada e a que pode custar dinheiro a alguém:
- podeCancelar() decide se o botão existe;
- antes de confirmar, a tela diz QUANTO VOLTA, em reais, usando
  reembolsoSeCancelarAgora() sobre o price_cents do próprio pedido;
- a confirmação é um Alert do sistema, com o valor repetido dentro dele;
- serviço em andamento não cancela: o caminho é registrar uma ocorrência, e a
  tela precisa dizer isso sem mandar a pessoa procurar (o Épico 6 é que traz a
  tela de ocorrência — aqui basta explicar e não prometer botão).

Leia assert_status_transition em 0001_schema.sql para não escrever na tela uma
promessa que o banco não cumpre.

Estrutura e tom: app/(client)/pets/[id].tsx. Tenha saída desenhada para a lista
(aquela tela não tinha, e foi achado de revisão).`,
  },
]

const revisar = [
  {
    key: 'consistencia',
    prompt: `Você revisa o Épico 3 inteiro, já escrito, procurando o que quebra.

NÃO conserte nada. Aponte, com arquivo, linha e o conserto pronto para colar.

Confira DE VERDADE, rodando, não lendo:
- npx tsc --noEmit limpo no projeto todo
- nenhum arquivo fora de src/api/ importando @supabase/supabase-js ou src/api/client
- NENHUM valor em reais e NENHUM cálculo de comissão em arquivo .ts/.tsx
  (grepe por 4000, 0.2, 20, 'R$' em código — não em texto de tela)
- as rotas app/(client)/pedidos/{index,novo,[id]}.tsx não colidem e o guarda de
  rota do _layout deixa passar
- toda dependência usada está no package.json na linha do SDK 54
  (\`npx expo install --check\`)
- config plugin declarado no app.json para toda biblioteca nativa nova
  (foi o achado CRÍTICO do épico anterior — confira de novo)
- os nomes exportados batem com o contrato que os outros agentes leram

E as três armadilhas específicas deste épico:
- [lat, lng] trocados em algum ponto do caminho GeoJSON → app → RPC.
  Prove com um caso: uma coordenada de Foz (-25.5163, -54.5854) tem que voltar
  em Foz depois da ida e volta.
- fuso: um horário escolhido às 14h em Foz tem que chegar como 17:00Z, e voltar
  como 14h na tela.
- reembolsoSeCancelarAgora() contra assert_status_transition: monte os dois casos
  (3 horas antes e 30 minutos antes) e compare o número do app com o do banco.
  Se puder rodar contra o container quati-db, rode.

Devolva { veredito: string, problemas: [{ arquivo, gravidade, problema, correcao }] }
com gravidade em 'critico' | 'alto' | 'medio' | 'baixo'.`,
  },
  {
    key: 'experiencia',
    prompt: `Você é uma tutora de 52 anos em Foz do Iguaçu. Tem uma cadela vira-lata
e um gato. Usa WhatsApp e o aplicativo do banco, e mais nada. Fonte do celular
aumentada. Nunca pediu um serviço por aplicativo na vida — vai pedir porque vai
viajar e alguém precisa cuidar dos bichos.

Leia as três telas de app/(client)/pedidos/ como quem vai USAR, não como quem
revisa código. Você está com pressa e com medo de errar e pagar por engano.

As perguntas que importam:
- Em que momento você descobre quanto vai pagar? Antes ou depois de se
  comprometer com o horário?
- Você entende que aceitou alguma coisa quando toca no botão? Consegue ler o que
  aceitou, se quiser?
- O endereço: você consegue passar dessa tela? Sozinha? E se estiver no trabalho
  na hora de pedir?
- Depois de confirmar, você sabe o que vai acontecer e quando? Ou fica olhando
  para uma tela sem saber se deu certo?
- Se der errado no meio, você perde tudo o que preencheu?
- Cancelar: você entende quanto volta ANTES de confirmar? Ou descobre depois?

Confira também o que se mede: contraste dos textos sobre o fundo dos dois temas,
alvo de toque de 44pt, e se alguma coisa pula de lugar na tela quando um aviso
aparece — o dedo já estava a caminho do botão.

NÃO conserte nada. Devolva { veredito: string, problemas: [{ arquivo, gravidade,
problema, correcao }] }, gravidade em 'critico' | 'alto' | 'medio' | 'baixo',
com a correção escrita pronta para colar. Ordene pelo que mais atrapalha quem
está tentando pedir.`,
  },
]

const comum = CONTEXTO + O_QUE_O_BANCO_JA_FAZ + AVISOS + CONTRATO + REGRAS_DE_ARQUIVO

phase('Base')
const feitosBase = await parallel(
  base.map((t) => () =>
    agent(comum + '\n\nSUA TAREFA:\n' + t.prompt, { label: `base:${t.key}`, phase: 'Base' }),
  ),
)

phase('Telas')
const feitasTelas = await parallel(
  telas.map((t) => () =>
    agent(
      comum +
        '\n\nA BASE JÁ ESTÁ ESCRITA. Leia os arquivos de src/api, src/schemas, src/lib e ' +
        'src/hooks antes de começar, e use o que está lá de verdade — não o que você ' +
        'imagina que está.\n\nSUA TAREFA:\n' +
        t.prompt,
      { label: `telas:${t.key}`, phase: 'Telas' },
    ),
  ),
)

phase('Revisar')
const revisoes = await parallel(
  revisar.map((t) => () =>
    agent(comum + '\n\nSUA TAREFA:\n' + t.prompt, {
      label: `revisar:${t.key}`,
      phase: 'Revisar',
    }),
  ),
)

return { base: feitosBase, telas: feitasTelas, revisoes }
