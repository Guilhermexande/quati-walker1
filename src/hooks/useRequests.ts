/**
 * A ponte entre as telas de pedidos e a camada de dados.
 *
 * Mesma divisão de usePets.ts: nenhuma tela conversa com o supabase — ela usa
 * estes hooks, e cada mutação responde por deixar o cache coerente depois de
 * escrever.
 *
 * O que muda neste épico: a linha do pedido se altera sem o app encostar nela.
 * Um passeador aceita e o estado vira 'reserved' com dez minutos para pagar; o
 * pg_cron expira a reserva vencida; o webhook do PIX confirma. Nada disso passa
 * por uma mutação daqui — logo, invalidar depois de escrever não basta: as
 * consultas precisam envelhecer sozinhas, e as duas que a pessoa fica olhando
 * se renovam sozinhas enquanto a tela está aberta. Ver os comentários de
 * staleTime em `useMyRequests` e `useRequest`.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { precoVigente } from '@/api/pricing'
import {
  cancelRequest,
  createRequest,
  getRequest,
  listMyRequests,
  ultimoEndereco,
  type RequestInput,
  type ServiceRequest,
} from '@/api/requests'
import { termosAtivos } from '@/api/terms'
import { useSessionStore } from '@/stores/session'

/** A lista de pedidos do tutor. Quem cria ou cancela invalida esta. */
const PEDIDOS = ['requests', 'list'] as const

/** Um pedido só. O id na chave é o que impede o pedido de A aparecer na tela de B. */
const pedido = (id: string) => ['requests', id] as const

/**
 * O endereço do último pedido, oferecido como atalho na hora de pedir o
 * próximo. Fica sob 'requests' de propósito: ele é lido dos próprios pedidos da
 * pessoa, e a chave deixa essa dependência à vista de quem for mexer aqui.
 */
const ULTIMO_ENDERECO = ['requests', 'ultimo-endereco'] as const

/** O preço vigente, guardado por serviço e duração — são eles que escolhem a linha. */
const PRECO = ['pricing'] as const

/** Os Termos em vigor. Um só de cada vez (`terms.active`). */
const TERMOS = ['terms', 'ativos'] as const

// O serviço sai da assinatura da API em vez de ser redigitado aqui: é a mesma
// razão de `useAuth.ts` tirar os dados do perfil de `Parameters<...>` — duas
// descrições da mesma coisa saem de sincronia sem ninguém perceber.
type Servico = Parameters<typeof precoVigente>[0]

type Cancelamento = { id: string; motivo?: string }

/**
 * Os pedidos do tutor, do mais novo para o mais antigo.
 *
 * É desta consulta que sai a lista em `pedidos/index.tsx` E o que a tela
 * inicial mostrar sobre serviço marcado — contagem, próximo passeio, aviso de
 * pagamento pendente. A tela inicial precisa ler ESTE hook: uma consulta
 * própria, com outra chave, não seria alcançada pelas invalidações daqui e
 * ficaria anunciando um pedido que já foi cancelado.
 */
export function useMyRequests() {
  const status = useSessionStore((s) => s.status)

  return useQuery({
    queryKey: PEDIDOS,
    queryFn: () => listMyRequests(),
    // Depois de sair não há pedido nenhum para buscar, e em 'loading' o app
    // ainda nem sabe quem abriu.
    enabled: status !== 'signed_out',

    // 30 segundos, e não os 5 minutos dos animais: animal só muda quando o
    // tutor mexe nele; pedido muda por gente de fora — o passeador aceita, o
    // pg_cron expira a reserva de 10 minutos, o webhook do PIX confirma.
    //
    // Mas staleTime sozinho não resolve quem abriu a lista às 8h e está olhando
    // para ela às 8h30: ele só decide se uma busca DISPARADA por alguma coisa
    // vale a pena, e com a tela parada não há disparo nenhum — o gatilho de
    // foco está desligado no _layout.tsx porque este app não liga o AppState.
    // Quem serve essa pessoa é o refetchInterval; o staleTime curto é para
    // quando ela volta para a lista vinda de outra tela.
    staleTime: 30_000,

    // Um minuto é o maior atraso que cabe numa janela de pagamento de dez: se o
    // passeador aceita às 8h05, a pessoa sabe até 8h06 e ainda tem nove minutos
    // para pagar. É a troca deste épico por não ter tempo real — e só roda
    // enquanto a lista está montada.
    refetchInterval: 60_000,
  })
}

/**
 * Um pedido, para a tela de detalhe.
 *
 * Aceita null porque o id chega da rota, e a rota pode abrir antes do parâmetro
 * existir. Com id nulo a consulta nem roda.
 */
export function useRequest(id: string | null) {
  const queryClient = useQueryClient()

  return useQuery({
    queryKey: pedido(id ?? 'sem-id'),
    queryFn: async () => (id === null ? null : await getRequest(id)),
    enabled: id !== null,
    // Quem abre o detalhe quase sempre veio da lista, e a lista já traz a linha
    // inteira. Mostrar o que já se tem enquanto a consulta anda evita a tela em
    // branco no meio do caminho.
    placeholderData: () =>
      queryClient.getQueryData<ServiceRequest[]>(PEDIDOS)?.find((p) => p.id === id) ?? undefined,

    // Metade do intervalo da lista porque aqui a espera é o assunto da tela: é
    // nela que a pessoa fica esperando alguém aceitar e é nela que corre o
    // prazo de pagamento. Estado velho aqui não é desatualização, é a pessoa
    // olhando para um cronômetro que já venceu.
    staleTime: 15_000,
    refetchInterval: 30_000,
  })
}

/**
 * Cria o pedido. Devolve só o id — o resto da linha é do servidor.
 *
 * Diferente de `useCreatePet`, não dá para guardar a linha no cache antes de
 * revalidar: preço, comissão, repasse, `ends_at`, a foto do animal e a versão
 * dos Termos são derivados pelo trigger `assert_request_insert`, e o app não
 * conhece nenhum desses valores. Inventar uma linha aqui seria mostrar um preço
 * que o app chutou — exatamente o que a decisão 2 do ADR proíbe.
 */
export function useCreateRequest() {
  const queryClient = useQueryClient()

  return useMutation<string, Error, RequestInput>({
    mutationFn: (input) => createRequest(input),
    onSuccess: async () => {
      await Promise.all([
        // A lista, que é também a fonte do que a tela inicial mostra sobre
        // serviço marcado.
        queryClient.invalidateQueries({ queryKey: PEDIDOS }),

        // E o atalho de endereço: ele é lido do último pedido, e o último
        // pedido acabou de ser este. Sem invalidar, a pessoa que mudou de
        // endereço agora recebe o endereço antigo já preenchido no próximo
        // pedido e confirma sem reparar — o passeador vai para a casa errada.
        queryClient.invalidateQueries({ queryKey: ULTIMO_ENDERECO }),
      ])
    },
  })
}

/**
 * Cancela o pedido.
 *
 * Não escreve o novo estado no cache de propósito: quanto volta para a pessoa é
 * decidido pelo trigger `assert_status_transition` (100% com 2h ou mais de
 * antecedência, metade abaixo disso) e gravado em `refund_cents` na própria
 * linha. Carimbar 'cancelled_client' aqui mostraria o cancelamento sem o valor
 * do reembolso, que é justamente o que a pessoa quer ler nessa hora.
 */
export function useCancelRequest() {
  const queryClient = useQueryClient()

  return useMutation<void, Error, Cancelamento>({
    mutationFn: ({ id, motivo }) => cancelRequest(id, motivo),
    onSuccess: async (_vazio, { id }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: pedido(id) }),
        queryClient.invalidateQueries({ queryKey: PEDIDOS }),
      ])
      // `ULTIMO_ENDERECO` fica de fora: cancelar não mexe no endereço da linha,
      // ela continua lá com o mesmo texto. Se `ultimoEndereco()` um dia passar
      // a ignorar pedidos cancelados, esta invalidação precisa entrar aqui.
    },
  })
}

/**
 * O preço vigente do serviço — o valor que a tela MOSTRA antes de confirmar.
 * Quem cobra é o trigger, a partir da tabela `pricing` (ADR, decisão 2).
 *
 * Aceita nulo porque o pedido é feito em passos: no primeiro render ninguém
 * escolheu animal nem duração ainda, e hook não se chama dentro de `if`.
 *
 * `temPreco` existe para a tela não precisar montar a pergunta toda vez —
 * "carregando OU deu erro OU o banco não tem linha vigente" são três jeitos
 * diferentes de não haver preço, e esquecer um deles libera o botão de
 * confirmar em cima de um valor que ninguém sabe qual é. A tela combina isto
 * com o que só ela sabe (coordenada do endereço, caixa dos Termos marcada).
 */
export function usePrecoVigente(service: Servico | null, duracaoMin: number | null) {
  const consulta = useQuery({
    queryKey: [...PRECO, service, duracaoMin] as const,
    queryFn: async () =>
      service === null || duracaoMin === null ? null : await precoVigente(service, duracaoMin),
    enabled: service !== null && duracaoMin !== null,
    // Preço muda por decisão administrativa, quase nunca, e a linha vigente é a
    // mesma para todo mundo. Cinco minutos evitam uma ida ao servidor a cada
    // passo do formulário sem deixar a tela presa a um valor de ontem.
    staleTime: 5 * 60 * 1000,
  })

  // `data` é undefined enquanto a consulta anda ou quando ela falha, e null
  // quando o banco respondeu que não há preço vigente para este serviço e esta
  // duração. Os três casos impedem pedir.
  const temPreco = consulta.data !== undefined && consulta.data !== null

  return { ...consulta, temPreco }
}

/**
 * Os Termos em vigor — a versão que a tela precisa mostrar e o endereço do
 * texto para quem quiser ler antes de aceitar.
 *
 * Não é `Infinity` como o e-mail da conta: quem carimba `terms_version` na
 * linha é o servidor (ADR, decisão 8), e o aceite só vale se a versão que a
 * pessoa viu na tela for a mesma que o banco gravou. Cinco minutos mantêm as
 * duas juntas sem buscar o mesmo texto a cada passo do formulário.
 *
 * `temTermos` pelo mesmo motivo de `temPreco`: sem Termos ativos não há o que
 * aceitar, e a tela não pode deixar confirmar.
 */
export function useTermosAtivos() {
  const consulta = useQuery({
    queryKey: TERMOS,
    queryFn: () => termosAtivos(),
    staleTime: 5 * 60 * 1000,
  })

  const temTermos = consulta.data !== undefined && consulta.data !== null

  return { ...consulta, temTermos }
}

/**
 * O endereço do último pedido, para a pessoa não digitar de novo o que já
 * digitou — e, principalmente, para reaproveitar a coordenada que veio junto.
 * É o primeiro dos dois caminhos de endereço deste épico; o outro é pedir a
 * localização de onde ela está agora.
 *
 * Devolve null para quem está pedindo pela primeira vez, e aí só resta o outro
 * caminho.
 */
export function useUltimoEndereco() {
  const status = useSessionStore((s) => s.status)

  return useQuery({
    queryKey: ULTIMO_ENDERECO,
    queryFn: () => ultimoEndereco(),
    enabled: status !== 'signed_out',
    // Só muda quando a pessoa faz um pedido novo, e esse caminho já invalida
    // esta chave em `useCreateRequest`.
    staleTime: 5 * 60 * 1000,
  })
}
