/**
 * O pedido por dentro — e o cancelamento.
 *
 * Esta tela responde duas perguntas, e a segunda custa dinheiro:
 *   "o que foi mesmo que eu combinei?"  → tudo o que está gravado na linha;
 *   "e se eu cancelar agora?"           → quanto volta, ANTES de confirmar.
 *
 * Três coisas que ela não faz, e cada uma tem motivo:
 *
 *   - NÃO calcula preço nem reembolso como se fossem verdade. O valor vem de
 *     `price_cents`, gravado pelo trigger `assert_request_insert` a partir da
 *     tabela `pricing` (ADR decisão 2). A previsão do cancelamento sai de
 *     `reembolsoSeCancelarAgora`, que copia o `assert_status_transition` — mas
 *     quem DECIDE é o banco, e é ele que grava `refund_cents`. Por isso a tela
 *     mostra a previsão antes e lê o valor gravado depois, em vez de tratar a
 *     previsão como resultado.
 *
 *   - NÃO lê o cadastro do animal. O que vale é o `pet_snapshot`: o cadastro
 *     como estava no dia do pedido, que é o que o passeador enxerga e o que
 *     conta se houver incidente. Mostrar o cadastro de hoje faria a tela contar
 *     uma história diferente da que o outro lado está lendo.
 *
 *   - NÃO promete botão que não existe. Serviço em andamento não cancela (o
 *     banco recusa, em `cancel_request`); o caminho é a ocorrência, que é do
 *     Épico 6. A tela explica o caminho e para por aí.
 */
import * as React from 'react'
import { Alert, Linking, StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'

import type { ServiceRequest } from '@/api/requests'
import {
  Body,
  Button,
  ErrorBanner,
  Loading,
  LongTextField,
  Screen,
  Title,
} from '@/components/ui'
import { useCancelRequest, useRequest, useTermosAtivos } from '@/hooks/useRequests'
import { useTheme, type Theme } from '@/lib/theme'
import { descricaoDoPorte } from '@/schemas/pet'
import {
  descricaoDoStatus,
  nomeDoServico,
  podeCancelar,
  reais,
  reembolsoSeCancelarAgora,
  type StatusDoPedido,
} from '@/schemas/request'

const MEUS_PEDIDOS = '/(client)/pedidos'

/**
 * De quanto em quanto tempo a tela se redesenha sozinha.
 *
 * O que envelhece aqui não é o dado, é o RELÓGIO: a previsão de reembolso vira
 * metade quando faltam menos de 2 horas, o prazo de 10 minutos da reserva
 * termina, e "hoje" vira "ontem" à meia-noite. Nenhuma dessas três muda a linha
 * no banco, então nenhuma chegaria por revalidação do react-query — a tela
 * ficaria prometendo R$ 40,00 de volta depois de o valor já ter caído para
 * R$ 20,00. Meio minuto é curto o bastante para ninguém ler o número errado e
 * longo o bastante para não pesar.
 */
const INTERVALO_DO_RELOGIO_MS = 30_000

/**
 * Os três sinais do tema, mais a ausência de sinal — os mesmos de
 * `pedidos/index.tsx`.
 *
 * A tabela está repetida aqui de propósito, e isso é dívida conhecida: ela
 * pertence ao mesmo lugar de `descricaoDoStatus`, mas o contrato do épico fixa
 * o que `@/schemas/request` exporta, e inventar um export novo quebraria os
 * outros agentes que estão escrevendo contra ele. Fechada por estado, como lá:
 * estado novo no banco quebra a compilação aqui em vez de nascer sem cor.
 */
const TOM: Record<StatusDoPedido, Tom> = {
  requested: 'neutro',
  reserved: 'atencao',
  confirmed: 'ok',
  in_progress: 'ok',
  completed: 'ok',
  expired: 'falha',
  cancelled_client: 'falha',
  cancelled_walker: 'falha',
}

type Tom = 'neutro' | 'atencao' | 'ok' | 'falha'

type Especie = 'dog' | 'cat'
type Porte = 'small' | 'medium' | 'large'

/** O animal como ele estava no dia do pedido. Tudo pode faltar — ver `animalDoPedido`. */
type AnimalDoPedido = {
  nome: string | null
  especie: Especie | null
  porte: Porte | null
  raca: string | null
  observacoes: string | null
  vacinaAte: string | null
}

export default function PedidoPorDentro(): React.JSX.Element {
  const router = useRouter()

  // O parâmetro da rota chega como texto, lista de textos ou nada — o
  // expo-router não promete mais que isso. Sem id não há pedido para buscar.
  const params = useLocalSearchParams()
  const idDaRota = typeof params['id'] === 'string' ? params['id'] : null

  const consulta = useRequest(idDaRota)

  function voltarParaLista(): void {
    // Quase sempre se chega aqui pela lista, e voltar preserva a rolagem dela.
    // O `replace` cobre quem abriu por link ou por notificação de aviso.
    if (router.canGoBack()) router.back()
    else router.replace(MEUS_PEDIDOS)
  }

  if (idDaRota === null) return <NaoEncontrado aoVoltar={voltarParaLista} />

  if (consulta.isError) {
    return (
      <Screen scroll>
        <Title>Não deu para abrir este pedido</Title>
        <Body>
          O aplicativo não conseguiu buscar o pedido agora. O serviço que você marcou continua
          marcado — nada foi desfeito por causa disso.
        </Body>
        <ErrorBanner message={consulta.error.message} />
        <Button
          label="Tentar de novo"
          onPress={() => void consulta.refetch()}
          loading={consulta.isFetching}
        />
        <Button label="Ver os meus pedidos" variant="ghost" onPress={voltarParaLista} />
      </Screen>
    )
  }

  if (consulta.isPending) {
    return (
      <Screen>
        <Loading />
      </Screen>
    )
  }

  const pedido = consulta.data ?? null

  // A RLS não distingue "não existe" de "é de outra pessoa": as duas devolvem
  // nada. Para quem está lendo, o efeito é o mesmo, e a saída também.
  if (pedido === null) return <NaoEncontrado aoVoltar={voltarParaLista} />

  // A chave zera o que a tela guarda (o motivo digitado) quando a rota troca de
  // pedido. Sem ela, abrir um segundo pedido carregaria o motivo do primeiro.
  return <Detalhe key={pedido.id} pedido={pedido} aoSair={voltarParaLista} />
}

function Detalhe({
  pedido,
  aoSair,
}: {
  pedido: ServiceRequest
  aoSair: () => void
}): React.JSX.Element {
  const s = useStyles()

  const cancelar = useCancelRequest()
  const termos = useTermosAtivos()

  const [motivo, setMotivo] = React.useState('')

  // O que dizer depois que o cancelamento deu certo. Guarda o valor prometido
  // no momento do toque; o valor que VALE é o do banco, e é ele que a tela relê
  // logo abaixo — por isso o texto fala em "deve voltar", não em "voltou".
  const [cancelado, setCancelado] = React.useState<{ centavos: number } | null>(null)
  const [erroDoLink, setErroDoLink] = React.useState<string | null>(null)

  const status: StatusDoPedido = pedido.status
  const cancelavel = podeCancelar(status)

  // Ver `INTERVALO_DO_RELOGIO_MS`. Só corre enquanto existe cancelamento
  // possível: é o único trecho da tela em que o tempo muda um número em reais.
  const [, marcarORelogio] = React.useState(0)
  React.useEffect(() => {
    if (!cancelavel) return
    const timer = setInterval(() => marcarORelogio((n) => n + 1), INTERVALO_DO_RELOGIO_MS)
    return () => clearInterval(timer)
  }, [cancelavel])

  const animal = animalDoPedido(pedido.pet_snapshot)
  const nome = animal.nome ?? 'Seu animal'

  // `confirmed_at` é carimbado quando o pagamento entra e nunca mais é apagado
  // (`assert_status_transition` o recopia em toda transição). É a resposta do
  // BANCO para "isto chegou a ser pago", e por isso não há lista de estados
  // escrita aqui para responder a mesma pergunta de outro jeito.
  const foiPago = pedido.confirmed_at !== null

  // `cancelled_at` é o carimbo comum a cancelado por qualquer lado e a vencido:
  // acabou sem o serviço ter acontecido.
  const acabouSemServico = pedido.cancelled_at !== null

  /**
   * O tutor não estava no endereço e o passeador esperou os 15 minutos
   * (`report_no_show`). O estado gravado é `cancelled_client`, o mesmo de quem
   * cancela pelo botão — e aí `descricaoDoStatus` diz "Você cancelou este
   * serviço", que não é o que aconteceu e some com a explicação de por que o
   * dinheiro não voltou. Só esta tela sabe distinguir, porque só ela lê
   * `cancelled_by`.
   */
  const tutorAusente = pedido.cancelled_by === 'no_show_client'

  const estado = descricaoDoStatus(status)
  const titulo = tutorAusente ? 'Serviço não realizado' : estado.titulo
  const explicacao = tutorAusente
    ? `Quem ia atender chegou ao endereço, esperou 15 minutos e não conseguiu pegar ${nome}. O serviço não aconteceu e, nesse caso, o valor pago não volta — está nos Termos de Uso.`
    : estado.explicacao

  const volta = reembolsoSeCancelarAgora(pedido.price_cents, pedido.scheduled_at, status)

  function alterarMotivo(texto: string): void {
    setMotivo(texto)
    // O erro da tentativa anterior fala do toque anterior. Deixá-lo na tela
    // enquanto a pessoa reescreve o motivo faz o aviso parecer resposta ao que
    // ela está digitando agora.
    if (cancelar.isError) cancelar.reset()
  }

  /**
   * A confirmação do cancelamento.
   *
   * O valor é recalculado AQUI, no toque, e não reaproveitado do que está na
   * tela: entre abrir a tela e apertar o botão o horário pode ter cruzado as 2
   * horas, e o Alert é a última coisa que a pessoa lê antes de perder metade do
   * dinheiro. Ele repete o valor no título e na explicação de propósito.
   *
   * Alert do sistema, e não um cartão da tela, porque é a confirmação que não
   * se fecha com o dedo de passagem — mesmo motivo da remoção de animal em
   * `pets/[id].tsx`.
   */
  function confirmarCancelamento(): void {
    const agora = reembolsoSeCancelarAgora(pedido.price_cents, pedido.scheduled_at, status)
    const centavosPrometidos = agora.centavos
    const limpo = motivo.trim()

    Alert.alert(
      agora.centavos > 0
        ? `Cancelar e receber ${reais(agora.centavos)} de volta?`
        : 'Cancelar este serviço?',
      `${agora.explicacao}\n\nDepois de cancelar não dá para voltar atrás. Se ainda quiser o passeio ou a visita, você precisa fazer um pedido novo.`,
      [
        { text: 'Manter o serviço', style: 'cancel' },
        {
          text: 'Cancelar o serviço',
          style: 'destructive',
          onPress: () =>
            cancelar.mutate(
              { id: pedido.id, motivo: limpo === '' ? undefined : limpo },
              {
                // Sem isto, cancelar era um ato sem resposta: `podeCancelar`
                // passava a ser falso, a seção inteira — título, valor de volta,
                // motivo, botão — desaparecia, a rolagem grudava no fim e a
                // pessoa ficava olhando para o rodapé. Depois de mexer com
                // dinheiro, ninguém deveria ficar sem recibo.
                onSuccess: () => setCancelado({ centavos: centavosPrometidos }),
              },
            ),
        },
      ],
      { cancelable: true },
    )
  }

  function abrirTermos(url: string): void {
    setErroDoLink(null)
    // O celular pode não ter navegador capaz de abrir o endereço, e a promessa
    // rejeitada sem tratamento derrubaria a tela inteira por causa de um link.
    Linking.openURL(url).catch(() =>
      setErroDoLink(
        'Não foi possível abrir o texto dos Termos neste aparelho. A versão que vale para este serviço continua sendo a que está escrita acima.',
      ),
    )
  }

  const quando = quandoPorExtenso(pedido.scheduled_at)
  const termina = soAHora(pedido.ends_at)

  /**
   * Os Termos publicados hoje são os mesmos que este pedido carimbou?
   *
   * A pergunta decide se dá para oferecer o texto: `terms.body_url` aponta para
   * a versão VIGENTE, e abri-la dizendo que é o que a pessoa aceitou mostraria
   * um contrato diferente do que está gravado na linha. O aceite por pedido
   * (ADR decisão 8) existe justamente para responder "qual texto valia naquele
   * dia" — a tela não pode ser a primeira a confundir os dois.
   */
  const termosDeHoje = termos.data ?? null
  const mesmaVersao = termosDeHoje !== null && termosDeHoje.version === pedido.terms_version
  const textoDosTermos = mesmaVersao ? termosDeHoje.bodyUrl : null

  return (
    <Screen scroll>
      <Title>{servicoPorExtenso(pedido.service, pedido.duration_minutes)}</Title>
      <Text style={s.subtitulo}>para {nome}</Text>

      <BlocoDoEstado tom={TOM[status]} titulo={titulo} explicacao={explicacao}>
        <PrazoDaReserva pedido={pedido} />

        {pedido.completed_at !== null ? (
          <LinhaDoEstado texto={`Encerrado em ${momentoPorExtenso(pedido.completed_at)}.`} />
        ) : null}

        {pedido.cancelled_at !== null ? (
          <LinhaDoEstado texto={`Encerrado em ${momentoPorExtenso(pedido.cancelled_at)}.`} />
        ) : null}

        <MotivoDoCancelamento pedido={pedido} tutorAusente={tutorAusente} />
      </BlocoDoEstado>

      <Text style={s.grupoTitulo} accessibilityRole="header">
        Dia e hora
      </Text>
      <Campo
        rotulo="Começa"
        valor={quando ?? 'Não conseguimos ler o horário deste serviço.'}
        // O horário sai em hora local, a mesma em que a pessoa escolheu no
        // aparelho dela: `scheduled_at` é timestamptz e guarda o instante, não
        // o texto. É por esta linha que ela confere se marcou o dia certo.
        ajuda={termina === null ? undefined : `Termina por volta das ${termina}.`}
      />
      <Body dim>
        O dia e a hora não mudam depois que o pedido é feito. Se você precisar de outro horário,
        cancele este pedido e faça um novo.
      </Body>

      <Text style={s.grupoTitulo} accessibilityRole="header">
        Onde
      </Text>
      <Campo
        rotulo="Endereço"
        valor={pedido.address_text}
        ajuda="É o endereço que você informou quando fez o pedido."
      />

      <Text style={s.grupoTitulo} accessibilityRole="header">
        Quem vai ser atendido
      </Text>
      {/* O snapshot é o que vale (ADR decisão 8, mesma ideia dos Termos): o
          passeador lê esta cópia, e não o cadastro de hoje. Se a tela mostrasse
          o cadastro atual, o tutor leria uma coisa e quem está com o animal
          leria outra — e a diferença só apareceria depois de um acidente. */}
      <Body dim>
        É o cadastro como estava no dia em que você fez o pedido. Se você mudou alguma coisa
        depois, quem for atender continua vendo o que está escrito aqui.
      </Body>

      <Campo rotulo="Nome" valor={nome} />
      <Campo rotulo="Cachorro ou gato" valor={especiePorExtenso(animal.especie)} />
      {animal.especie === 'cat' ? null : (
        <Campo rotulo="Porte" valor={descricaoDoPorte(animal.porte)} />
      )}
      <Campo rotulo="Raça" valor={animal.raca ?? 'Não informada'} />
      <Campo
        rotulo="Vacina antirrábica válida até"
        valor={deISO(animal.vacinaAte) ?? 'Não informada'}
      />
      <Campo
        rotulo="O que quem cuida dele precisa saber"
        valor={animal.observacoes ?? 'Você não escreveu nada sobre ele neste pedido.'}
      />

      <Text style={s.grupoTitulo} accessibilityRole="header">
        Valor
      </Text>
      <Campo
        rotulo={foiPago ? 'Valor pago' : 'Valor do serviço'}
        valor={reais(pedido.price_cents)}
        ajuda={
          foiPago
            ? 'Este é o valor deste serviço. Mudança de preço depois não mexe em pedido já feito.'
            : acabouSemServico
              ? 'Era o valor combinado para este serviço.'
              : 'O valor ficou travado quando você fez o pedido. Você paga depois que alguém aceitar.'
        }
      />

      <FechamentoDoValor pedido={pedido} acabouSemServico={acabouSemServico} />

      <Text style={s.grupoTitulo} accessibilityRole="header">
        Termos de Uso
      </Text>
      <Campo
        rotulo={`Versão ${pedido.terms_version}`}
        valor={`Aceita por você em ${momentoPorExtenso(pedido.terms_accepted_at)}.`}
        ajuda="É esta versão que vale para este serviço, e ela fica guardada junto com o pedido."
      />

      {textoDosTermos !== null ? (
        <Button
          label="Ler os Termos de Uso"
          variant="ghost"
          onPress={() => abrirTermos(textoDosTermos)}
        />
      ) : mesmaVersao ? (
        // A coluna `body_url` pode estar vazia — hoje a minuta v1.0 vive fora
        // do banco. Botão que não abre nada é pior que a ausência do botão.
        <Body dim>O texto desta versão ainda não está disponível para leitura por aqui.</Body>
      ) : termosDeHoje !== null ? (
        <Body dim>
          Os Termos mudaram desde então: hoje vale a versão {termosDeHoje.version}. Para este
          serviço continua valendo a versão {pedido.terms_version}, que foi a que você aceitou.
        </Body>
      ) : null}

      {erroDoLink === null ? null : <ErrorBanner message={erroDoLink} />}

      <View style={s.divisor} />

      {/* O recibo do cancelamento, no lugar onde o botão estava. Fica acima do
          bloco cancelável de propósito: quando o cancelamento dá certo aquele
          bloco some inteiro, e sem nada no lugar a pessoa não sabe se o toque
          valeu. Quem paga é o banco — daí "deve voltar", e não "voltou". */}
      {cancelado !== null ? (
        <View style={s.dinheiro} accessibilityLiveRegion="polite">
          <Text style={s.dinheiroValor} accessibilityRole="header">
            Serviço cancelado
          </Text>
          <Text style={s.dinheiroTexto}>
            {cancelado.centavos > 0
              ? `Você cancelou o serviço e ${reais(cancelado.centavos)} devem voltar para você. O valor exato é o que aparece acima, em Valor — é o que o servidor registrou.`
              : 'Você cancelou o serviço. Como nada tinha sido pago ainda, não há valor a devolver.'}
          </Text>
        </View>
      ) : null}

      {cancelavel ? (
        <>
          <Text style={s.grupoTitulo} accessibilityRole="header">
            Cancelar este serviço
          </Text>

          {/* O valor de volta vem primeiro, grande, antes de qualquer botão:
              essa é a informação que decide se a pessoa cancela agora ou espera,
              e ela não pode aparecer só dentro da confirmação. */}
          <View style={s.dinheiro}>
            <Text style={s.dinheiroValor} accessibilityRole="header">
              {volta.centavos > 0
                ? `Volta para você: ${reais(volta.centavos)}`
                : 'Cancelar agora não custa nada'}
            </Text>
            <Text style={s.dinheiroTexto}>{volta.explicacao}</Text>
          </View>

          {foiPago ? (
            <Body dim>
              Quem fecha a conta é o servidor, no instante em que o cancelamento for registrado.
              Se o horário estiver perto das 2 horas, o valor pode mudar entre agora e o seu
              toque — o aviso de confirmação mostra o valor daquele momento.
            </Body>
          ) : null}

          <LongTextField
            label="Se quiser, conte por que está cancelando"
            help="Não é obrigatório. Quem tiver aceitado o seu pedido lê o que você escrever aqui."
            value={motivo}
            onChangeText={alterarMotivo}
            placeholder={`Ex.: ${nome} ficou doente e vou levar ao veterinário.`}
          />

          {cancelar.error !== null ? <ErrorBanner message={cancelar.error.message} /> : null}

          <Button
            label="Cancelar este serviço"
            variant="ghost"
            loading={cancelar.isPending}
            onPress={confirmarCancelamento}
          />

          <View style={s.divisor} />
        </>
      ) : status === 'in_progress' ? (
        <>
          <Text style={s.grupoTitulo} accessibilityRole="header">
            Precisa interromper?
          </Text>
          {/* `cancel_request` recusa em andamento: 'serviço em andamento não
              pode ser cancelado; registre um incidente'. Não existe botão aqui
              porque não existe caminho — e oferecer um que o banco vai recusar
              é pior do que explicar. A tela de ocorrência é do Épico 6. */}
          <Body>
            O serviço já começou, e por isso o cancelamento não passa por esta tela: quem está
            com {nome} já saiu de casa.
          </Body>
          <Body>
            Se alguma coisa estiver errada agora, o caminho é registrar uma ocorrência — é por
            ela que se decide o que acontece com o valor deste serviço.
          </Body>
          <Body dim>
            O registro de ocorrência ainda não está no aplicativo; ele chega por atualização,
            como o resto.
          </Body>

          <View style={s.divisor} />
        </>
      ) : null}

      {/* Saída desenhada. O _layout desliga o cabeçalho do Stack, então sem este
          botão sobra o gesto de arrastar da borda no iPhone — e nada no Android
          de quem entrou por uma notificação. */}
      <Button
        label="Voltar para os meus pedidos"
        variant="ghost"
        disabled={cancelar.isPending}
        onPress={aoSair}
      />
    </Screen>
  )
}

/**
 * O estado do pedido, escrito e colorido.
 *
 * A cor nunca está sozinha: o título diz a mesma coisa por extenso, para quem
 * não distingue as duas e para quem está lendo no sol.
 */
function BlocoDoEstado({
  tom,
  titulo,
  explicacao,
  children,
}: {
  tom: Tom
  titulo: string
  explicacao: string
  children?: React.ReactNode
}): React.JSX.Element {
  const s = useStyles()

  const fundo = {
    neutro: s.estadoNeutro,
    atencao: s.estadoAtencao,
    ok: s.estadoOk,
    falha: s.estadoFalha,
  }[tom]

  const cor = {
    neutro: s.estadoTituloNeutro,
    atencao: s.estadoTituloAtencao,
    ok: s.estadoTituloOk,
    falha: s.estadoTituloFalha,
  }[tom]

  return (
    <View style={[s.estado, fundo]} accessibilityLiveRegion="polite">
      <Text style={[s.estadoTitulo, cor]} accessibilityRole="header">
        {titulo}
      </Text>
      <Text style={s.estadoTexto}>{explicacao}</Text>
      {children}
    </View>
  )
}

function LinhaDoEstado({ texto }: { texto: string }): React.JSX.Element {
  const s = useStyles()
  return <Text style={s.estadoTexto}>{texto}</Text>
}

/**
 * O prazo de 10 minutos da reserva (ADR decisão 3).
 *
 * Aparece só enquanto ele é o assunto. Quando o prazo já passou e o estado
 * continua 'reserved', a tela não promete "em instantes vence": quem expira a
 * reserva é o `expire_stale_reservations()` no pg_cron, e o ADR chama esse
 * agendamento de o ponto de falha silencioso mais provável do sistema. Dizer o
 * que acontece — e não quando — é o que dá para garantir.
 */
function PrazoDaReserva({ pedido }: { pedido: ServiceRequest }): React.JSX.Element | null {
  const s = useStyles()

  if (pedido.status !== 'reserved' || pedido.reserved_until === null) return null

  const limite = new Date(pedido.reserved_until).getTime()
  if (Number.isNaN(limite)) return null

  if (limite <= Date.now()) {
    return (
      <Text style={s.estadoTexto}>
        O prazo desta reserva terminou e o horário voltou a ficar livre. Se você ainda quiser o
        serviço, faça um pedido novo — e se ninguém falou com você sobre o pagamento, a falha
        foi nossa, não sua.
      </Text>
    )
  }

  // O prazo é real e o banco o cobra (`expire_stale_requests`). Mas cobrar
  // pressa de alguém sem lhe dar o botão de pagar é armadilha — por isso o
  // horário aparece como informação, não como ordem.
  return (
    <Text style={s.estadoTexto}>
      A reserva vale até as {horaPorExtenso(new Date(limite))}. O pagamento ainda não acontece
      dentro do aplicativo; vamos falar com você antes disso.
    </Text>
  )
}

/** O que foi escrito no cancelamento, por quem cancelou. */
function MotivoDoCancelamento({
  pedido,
  tutorAusente,
}: {
  pedido: ServiceRequest
  tutorAusente: boolean
}): React.JSX.Element | null {
  const s = useStyles()

  // No caso do tutor ausente o motivo é texto do sistema ('tutor ausente'),
  // escrito pela RPC e não por uma pessoa. Repeti-lo entre aspas faria parecer
  // que alguém digitou aquilo sobre ela.
  if (tutorAusente) return null

  const escrito = pedido.cancel_reason?.trim()
  if (escrito === undefined || escrito === '') return null

  const dono =
    pedido.cancelled_by === 'client'
      ? 'O motivo que você escreveu:'
      : 'O motivo que quem ia atender escreveu:'

  return (
    <Text style={s.estadoTexto}>
      {dono} “{escrito}”
    </Text>
  )
}

/**
 * O fecho financeiro de um serviço que acabou sem acontecer.
 *
 * Tudo aqui é leitura de coluna, nada é conta: `refund_cents` e
 * `final_payout_cents` são gravados pelo `assert_status_transition`.
 *
 * A distinção que importa está em `final_payout_cents`: quando o serviço nunca
 * foi pago, o trigger o deixa nulo e grava reembolso zero — e "R$ 0,00 de
 * volta" numa tela, para quem nunca pagou nada, é um susto sem motivo. Quando
 * ele tem valor e o reembolso é zero, alguém perdeu dinheiro de verdade e a
 * frase precisa dizer isso.
 */
function FechamentoDoValor({
  pedido,
  acabouSemServico,
}: {
  pedido: ServiceRequest
  acabouSemServico: boolean
}): React.JSX.Element | null {
  if (!acabouSemServico || pedido.refund_cents === null) return null

  if (pedido.refund_cents > 0) {
    return (
      <Campo
        rotulo="Volta para você"
        valor={reais(pedido.refund_cents)}
        ajuda="É o valor registrado neste pedido, calculado pelo servidor no momento do cancelamento."
      />
    )
  }

  if (pedido.final_payout_cents === null) {
    return <Body dim>Você não chegou a pagar nada por este serviço.</Body>
  }

  return (
    <Campo
      rotulo="Volta para você"
      valor={reais(0)}
      ajuda="Neste caso o valor pago não volta. A explicação está no estado do pedido, no começo desta tela."
    />
  )
}

/** Um dado do pedido: rótulo, valor e, quando ajuda, uma linha de explicação. */
function Campo({
  rotulo,
  valor,
  ajuda,
}: {
  rotulo: string
  valor: string
  ajuda?: string
}): React.JSX.Element {
  const s = useStyles()

  return (
    <View
      style={s.campo}
      // Sem isto o leitor de tela para três vezes em cada dado — rótulo, valor
      // e explicação — e quem ouve perde de vista a qual rótulo o valor pertence.
      accessible
      accessibilityLabel={`${rotulo}: ${valor}${ajuda === undefined ? '' : `. ${ajuda}`}`}
    >
      <Text style={s.campoRotulo}>{rotulo}</Text>
      <Text style={s.campoValor}>{valor}</Text>
      {ajuda === undefined ? null : <Text style={s.campoAjuda}>{ajuda}</Text>}
    </View>
  )
}

function NaoEncontrado({ aoVoltar }: { aoVoltar: () => void }): React.JSX.Element {
  return (
    <Screen scroll>
      <Title>Não encontramos este pedido</Title>
      <Body>
        Ou o endereço que abriu esta tela está errado, ou o pedido é de outra conta. Cada pessoa
        enxerga só os serviços que ela mesma pediu.
      </Body>
      <Body dim>Volte para a sua lista e abra um dos seus.</Body>
      <Button label="Ver os meus pedidos" onPress={aoVoltar} />
    </Screen>
  )
}

// =============================================================================
// O snapshot do animal
// =============================================================================

/**
 * O animal como o `assert_request_insert` o congelou.
 *
 * A coluna é `jsonb` e chega tipada como Json: do ponto de vista do compilador
 * qualquer forma é possível, ainda que o trigger sempre monte o mesmo objeto.
 * Cada campo é conferido separadamente e vira null quando não serve — uma linha
 * antiga, ou um campo que mudou de nome numa migração futura, não pode derrubar
 * a tela que mostra o endereço e o valor do serviço.
 */
function animalDoPedido(snapshot: ServiceRequest['pet_snapshot']): AnimalDoPedido {
  const vazio: AnimalDoPedido = {
    nome: null,
    especie: null,
    porte: null,
    raca: null,
    observacoes: null,
    vacinaAte: null,
  }

  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return vazio

  return {
    nome: textoDoJson(snapshot['name']),
    especie: umDosValores(snapshot['species'], ['dog', 'cat']),
    porte: umDosValores(snapshot['size'], ['small', 'medium', 'large']),
    raca: textoDoJson(snapshot['breed']),
    observacoes: textoDoJson(snapshot['risk_notes']),
    vacinaAte: textoDoJson(snapshot['rabies_valid_until']),
  }
}

function textoDoJson(valor: ServiceRequest['pet_snapshot'] | undefined): string | null {
  if (typeof valor !== 'string') return null
  const limpo = valor.trim()
  return limpo === '' ? null : limpo
}

/**
 * Texto que precisa ser um dos valores de um enum do banco.
 *
 * Genérica porque são dois campos com a mesma pergunta; a lista de valores vem
 * de quem chama, e o tipo do retorno sai dela — assim um valor novo em
 * `pet_species` não passa despercebido por causa de um `as`.
 */
function umDosValores<T extends string>(
  valor: ServiceRequest['pet_snapshot'] | undefined,
  aceitos: readonly T[],
): T | null {
  return aceitos.find((aceito) => aceito === valor) ?? null
}

function especiePorExtenso(especie: Especie | null): string {
  if (especie === null) return 'Não informado'
  return especie === 'cat' ? 'Gato' : 'Cachorro'
}

// =============================================================================
// Texto de serviço, data e hora
// =============================================================================

/**
 * Estes ajudantes são os mesmos de `pedidos/index.tsx`, e a repetição é
 * conhecida: o contrato do épico fixa o que cada arquivo exporta, e nenhum dos
 * dois pode ganhar um export novo sem quebrar quem escreve contra eles. O que
 * muda aqui é o que a tela de detalhe pede a mais — o dia da semana por
 * extenso, que é o que faz a pessoa reparar que marcou sábado sem querer.
 */

const DIAS_DA_SEMANA: readonly string[] = [
  'domingo',
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
]

/** "Passeio de 1 hora", "Visita em casa de 30 minutos". */
function servicoPorExtenso(service: ServiceRequest['service'], minutos: number): string {
  const nome = comMaiuscula(nomeDoServico(service))
  const duracao = duracaoPorExtenso(minutos)
  return duracao === null ? nome : `${nome} de ${duracao}`
}

/**
 * 30 vira "30 minutos", 60 vira "1 hora", 90 vira "1 hora e 30 minutos".
 *
 * Quais durações existem é a tabela `pricing` que diz, e por isso nenhuma delas
 * está escrita aqui: a função converte o número que vier.
 */
function duracaoPorExtenso(minutos: number): string | null {
  if (!Number.isInteger(minutos) || minutos <= 0) return null

  const horas = Math.floor(minutos / 60)
  const resto = minutos % 60

  const emMinutos = `${resto} ${resto === 1 ? 'minuto' : 'minutos'}`
  if (horas === 0) return emMinutos

  const emHoras = `${horas} ${horas === 1 ? 'hora' : 'horas'}`
  return resto === 0 ? emHoras : `${emHoras} e ${emMinutos}`
}

/**
 * O horário do serviço, do jeito que se fala em Foz.
 *
 * O que chega é o ISO com fuso do `timestamptz`; o `Date` o converte para o
 * fuso do aparelho, que é o mesmo em que a pessoa escolheu o horário. Todas as
 * contas usam os componentes locais — usar UTC trocaria o dia de qualquer
 * serviço marcado depois das 21h, e o erro só apareceria na hora do passeio.
 *
 * Sem `toLocaleString` pelo mesmo motivo que `reais` não usa `Intl`: o Hermes
 * entrega o ICU em versões diferentes conforme o aparelho, e a mesma data sai
 * escrita de dois jeitos em dois celulares.
 */
function quandoPorExtenso(iso: string): string | null {
  const data = new Date(iso)
  if (Number.isNaN(data.getTime())) return null

  return comMaiuscula(`${diaPorExtenso(data)}, às ${horaPorExtenso(data)}`)
}

/** "12/09/2026 às 15h30". Para carimbo, onde "hoje" não ajuda a datar nada. */
function momentoPorExtenso(iso: string): string {
  const data = new Date(iso)
  if (Number.isNaN(data.getTime())) return 'data não disponível'

  return `${dataNumerica(data)} às ${horaPorExtenso(data)}`
}

/** Só a hora, para o fim previsto e para o prazo da reserva. */
function soAHora(iso: string): string | null {
  const data = new Date(iso)
  if (Number.isNaN(data.getTime())) return null
  return horaPorExtenso(data)
}

function diaPorExtenso(data: Date): string {
  const numerica = dataNumerica(data)
  const diferenca = diasDeCalendario(data, new Date())

  if (diferenca === 0) return `hoje (${numerica})`
  if (diferenca === 1) return `amanhã (${numerica})`
  if (diferenca === -1) return `ontem (${numerica})`

  const semana = DIAS_DA_SEMANA[data.getDay()]
  return semana === undefined ? numerica : `${semana}, ${numerica}`
}

/**
 * Quantos dias de calendário separam os dois — não quantas vezes 24 horas.
 *
 * Um passeio às 8h de amanhã está a 15 horas de distância às 17h de hoje, e
 * "amanhã" continua sendo a resposta certa. Por isso a conta é feita sobre a
 * meia-noite local de cada lado; o arredondamento cobre o dia que não tem 24
 * horas exatas, como o de uma mudança de horário de verão.
 */
function diasDeCalendario(alvo: Date, agora: Date): number {
  const meiaNoiteDoAlvo = new Date(alvo.getFullYear(), alvo.getMonth(), alvo.getDate()).getTime()
  const meiaNoiteDeHoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).getTime()

  return Math.round((meiaNoiteDoAlvo - meiaNoiteDeHoje) / 86_400_000)
}

function dataNumerica(data: Date): string {
  const dia = `${data.getDate()}`.padStart(2, '0')
  const mes = `${data.getMonth() + 1}`.padStart(2, '0')
  return `${dia}/${mes}/${data.getFullYear()}`
}

/** 15h30, e 8h quando não há minutos. Relógio de 24 horas, como se fala aqui. */
function horaPorExtenso(data: Date): string {
  const hora = data.getHours()
  const minuto = data.getMinutes()

  return minuto === 0 ? `${hora}h` : `${hora}h${`${minuto}`.padStart(2, '0')}`
}

/** AAAA-MM-DD para DD/MM/AAAA — a data da vacina, como está na carteirinha. */
function deISO(iso: string | null): string | null {
  if (iso === null) return null

  const [ano, mes, dia] = iso.split('-')
  if (ano === undefined || mes === undefined || dia === undefined) return null

  return `${dia}/${mes}/${ano}`
}

function comMaiuscula(texto: string): string {
  return `${texto.charAt(0).toUpperCase()}${texto.slice(1)}`
}

const sheets = new WeakMap<Theme, ReturnType<typeof createStyles>>()

function useStyles(): ReturnType<typeof createStyles> {
  const theme = useTheme()
  const cached = sheets.get(theme)
  if (cached) return cached
  const created = createStyles(theme)
  sheets.set(theme, created)
  return created
}

function createStyles(t: Theme) {
  const { colors: c, spacing, radius, font } = t

  return StyleSheet.create({
    subtitulo: {
      color: c.textDim,
      fontSize: font.size.md,
      lineHeight: font.line.md,
      // Cola no título: os dois são uma frase só ("Passeio de 1 hora para Mel").
      marginTop: -spacing.sm,
    },

    estado: {
      borderRadius: radius.md,
      padding: spacing.md,
      gap: spacing.sm,
    },
    // Cinza é a ausência de aviso, e é o lugar de `requested`: o pedido está no
    // ar, ninguém precisa fazer nada, e cor de alerta aqui só geraria aflição.
    estadoNeutro: { backgroundColor: c.surfaceAlt },
    estadoAtencao: { backgroundColor: c.accentSoft },
    estadoOk: { backgroundColor: c.primarySoft },
    estadoFalha: { backgroundColor: c.dangerSoft },
    estadoTitulo: {
      fontSize: font.size.lg,
      lineHeight: font.line.lg,
      fontWeight: font.weight.bold,
    },
    estadoTituloNeutro: { color: c.text },
    estadoTituloAtencao: { color: c.accent },
    estadoTituloOk: { color: c.primary },
    estadoTituloFalha: { color: c.danger },
    // O corpo fica na cor normal de texto nos quatro fundos: são cores suaves,
    // e o contraste de um parágrafo inteiro na cor do sinal cansa de ler.
    estadoTexto: {
      color: c.text,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
    },

    grupoTitulo: {
      color: c.text,
      fontSize: font.size.md,
      lineHeight: font.line.md,
      fontWeight: font.weight.bold,
      marginTop: spacing.sm,
    },

    campo: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.divider,
      borderRadius: radius.md,
      padding: spacing.md,
      gap: 2,
    },
    campoRotulo: {
      color: c.textDim,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
      fontWeight: font.weight.medium,
    },
    campoValor: {
      color: c.text,
      fontSize: font.size.md,
      lineHeight: font.line.md,
      fontWeight: font.weight.medium,
    },
    campoAjuda: {
      color: c.textDim,
      fontSize: font.size.xs,
      lineHeight: font.line.xs,
      marginTop: spacing.xs,
    },

    // O bloco do dinheiro do cancelamento. Fundo de apoio e não cor de alarme:
    // cancelar dentro do prazo é um direito, não um problema — o que precisa
    // saltar é o número, e ele salta pelo tamanho.
    dinheiro: {
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      padding: spacing.md,
      gap: spacing.xs,
    },
    dinheiroValor: {
      color: c.text,
      fontSize: font.size.lg,
      lineHeight: font.line.lg,
      fontWeight: font.weight.bold,
    },
    dinheiroTexto: {
      color: c.text,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
    },

    divisor: {
      height: 1,
      backgroundColor: c.divider,
      marginTop: spacing.lg,
    },
  })
}
