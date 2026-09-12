/**
 * Os pedidos do tutor, em lista.
 *
 * A pergunta que traz alguém a esta tela é uma só: "em que pé está?". Por isso
 * o estado vem primeiro dentro do cartão, antes do nome do animal, e por isso
 * cada linha responde sem precisar de toque — qual animal, qual serviço, que
 * dia e hora, e o estado por escrito.
 *
 * Os oito estados são os de `request_status` (docs/maquina-de-estados.md), e o
 * texto de cada um mora em `descricaoDoStatus`, em @/schemas/request — não
 * aqui. A tela de detalhe diz a mesma coisa, e duas cópias da mesma frase saem
 * de sincronia na primeira vez que alguém melhorar uma delas.
 *
 * `requested` é onde a pessoa passa mais tempo olhando: o pedido está no ar e
 * ninguém aceitou ainda. É o único estado em que a espera é a notícia — fica em
 * cinza, sem cor de alarme e sem prazo escrito, porque não existe prazo para
 * prometer. Quem aceita é o passeador, quando aceitar. Inventar aqui um "em
 * média 10 minutos" seria uma promessa que este app não tem como cumprir.
 *
 * Valor não aparece aqui. A lista responde "em que pé está", e dinheiro é a
 * conversa da tela de dentro — é lá que se paga e se cancela, e é lá que cabe
 * dizer quanto volta. Uma coluna de reais em cada linha disputaria a atenção
 * justamente com o estado, que é o que a pessoa veio ver.
 *
 * E nada aqui é calculado: estado, horário e duração vêm prontos da linha do
 * pedido; a tela só os escreve por extenso.
 */
import * as React from 'react'
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'

import type { ServiceRequest } from '@/api/requests'
import { Body, Button, ErrorBanner, Loading, Screen, Title } from '@/components/ui'
import { useMyPets } from '@/hooks/usePets'
import { useMyRequests } from '@/hooks/useRequests'
import { useTheme, type Theme } from '@/lib/theme'
import { descricaoDoStatus, nomeDoServico, type StatusDoPedido } from '@/schemas/request'

/** As telas vizinhas. Juntas aqui em cima para o dia em que o caminho mudar. */
const NOVO_PEDIDO = '/(client)/pedidos/novo'
const CADASTRO_DE_ANIMAL = '/(client)/pets/novo'
const MEUS_ANIMAIS = '/(client)/pets'
const pedidoEm = (id: string) => `/(client)/pedidos/${id}` as const

/**
 * Os três sinais do tema, mais a ausência de sinal.
 *
 * `neutro` não é uma quarta cor: é fundo de apoio com texto normal, o mesmo que
 * o app já usa em bloco que não avisa nada. Ele existe para `requested` — pintar
 * de laranja um pedido que está apenas esperando faz a pessoa achar que tem algo
 * para ela resolver, e não tem.
 */
type Tom = 'neutro' | 'atencao' | 'ok' | 'falha'

/**
 * O que cada estado faz no cartão.
 *
 * Tabela fechada de propósito, como `podeCancelar`: estado novo no banco quebra
 * a compilação aqui e obriga quem for mexer a decidir a cor e se a explicação
 * aparece na lista — em vez de nascer cinza e mudo sem ninguém reparar.
 *
 * `explicaNaLista` separa o que ainda vai acontecer do que já acabou. Nos
 * quatro estados finais o título é a história inteira ("Concluído", "Venceu",
 * "Cancelado por você"), e repetir o parágrafo em cada linha antiga enterraria
 * o pedido de hoje no meio do histórico. Nos outros quatro a frase diz o que
 * vem a seguir, que é justamente o que a pessoa abriu o app para saber.
 */
const ESTADO: Record<StatusDoPedido, { tom: Tom; explicaNaLista: boolean }> = {
  requested: { tom: 'neutro', explicaNaLista: true },
  reserved: { tom: 'atencao', explicaNaLista: true },
  confirmed: { tom: 'ok', explicaNaLista: true },
  in_progress: { tom: 'ok', explicaNaLista: true },
  completed: { tom: 'ok', explicaNaLista: false },
  expired: { tom: 'falha', explicaNaLista: false },
  cancelled_client: { tom: 'falha', explicaNaLista: false },
  cancelled_walker: { tom: 'falha', explicaNaLista: false },
}

/** Em que situação a pessoa está quando não há nenhum pedido ainda. */
type Partida = 'carregando' | 'sem-animal' | 'com-animal' | 'nao-sei'

export default function MeusPedidos(): React.JSX.Element {
  const router = useRouter()
  const theme = useTheme()
  const s = useStyles()
  const pedidos = useMyRequests()
  const animais = useMyPets()

  const lista = pedidos.data ?? []

  /**
   * Se a rodinha de "puxar para atualizar" está acesa.
   *
   * Aqui o `refreshing` NÃO pode ser o `isRefetching` da consulta, que é o que
   * a lista de animais usa: `useMyRequests` rebusca sozinha a cada minuto, e
   * `isRefetching` fica verdadeiro nessas buscas também. A rodinha acenderia e
   * a lista desceria um dedo sozinha, de minuto em minuto, na tela em que a
   * pessoa fica parada esperando alguém aceitar — parecendo que ela esbarrou em
   * alguma coisa. Só o gesto dela acende a rodinha; a renovação de fundo é
   * calada, e é essa a graça dela.
   */
  const [puxando, setPuxando] = React.useState(false)

  async function atualizarPuxando(): Promise<void> {
    setPuxando(true)
    try {
      // `refetch` resolve mesmo quando a busca falha — o erro fica na consulta,
      // e é a própria tela que o mostra. O `finally` é para não deixar a
      // rodinha presa se um dia ela passar a rejeitar.
      await pedidos.refetch()
    } finally {
      setPuxando(false)
    }
  }

  // Só muda o texto do estado vazio, e por isso não atrapalha quem tem pedidos:
  // a consulta de animais já está no cache por causa da tela de animais, e quem
  // chega aqui com lista cheia nunca chega a ler esta variável.
  const partida: Partida = animais.isPending
    ? 'carregando'
    : animais.data === undefined
      ? 'nao-sei'
      : animais.data.length === 0
        ? 'sem-animal'
        : 'com-animal'

  function irParaNovoPedido(): void {
    router.push(NOVO_PEDIDO)
  }

  function voltar(): void {
    // A raiz não mostra cabeçalho (headerShown: false), então este botão é a
    // única saída desenhada. Quem abriu a lista por link não tem para onde
    // voltar — daí o destino fixo em vez de um back que não faria nada.
    if (router.canGoBack()) router.back()
    else router.replace('/(client)/inicio')
  }

  /**
   * O convite para quem nunca pediu nada.
   *
   * São duas situações diferentes e o caminho de saída é outro em cada uma:
   * quem não tem animal cadastrado não tem o que pedir ainda, e mandá-la para o
   * pedido seria mandá-la para uma tela sem nenhuma opção para escolher.
   */
  function vazio(): React.JSX.Element {
    if (partida === 'carregando') return <Loading />

    return (
      <View style={s.centro}>
        <Text style={s.blocoTitulo} accessibilityRole="header">
          Você ainda não pediu nenhum serviço
        </Text>
        <Body>
          Aqui ficam os passeios e as visitas em casa que você pedir, com o dia, a hora e o
          que está acontecendo com cada um.
        </Body>

        {partida === 'sem-animal' ? (
          <>
            <Body dim>
              O primeiro passo é cadastrar o seu animal: é ele que o passeador vai atender, e
              a data da vacina antirrábica é obrigatória para pedir qualquer serviço.
            </Body>
            <Button label="Cadastrar meu animal" onPress={() => router.push(CADASTRO_DE_ANIMAL)} />
          </>
        ) : partida === 'com-animal' ? (
          <>
            <Body dim>
              Seu animal já está cadastrado. Escolha ele, o dia e a hora, e o pedido fica à
              vista dos passeadores da região.
            </Body>
            <Button label="Pedir um passeio ou uma visita" onPress={irParaNovoPedido} />
          </>
        ) : (
          // Não deu para ler a lista de animais. Em vez de chutar um dos dois
          // convites e levar a pessoa para a tela errada, a saída é a lista de
          // animais — que está certa nas duas situações.
          <>
            <Body dim>
              Para pedir um serviço você precisa de um animal cadastrado. Abra a sua lista de
              animais para conferir.
            </Body>
            <Button label="Meus animais" onPress={() => router.push(MEUS_ANIMAIS)} />
          </>
        )}
      </View>
    )
  }

  function corpo(): React.JSX.Element {
    if (pedidos.isPending) return <Loading />

    if (pedidos.isError) {
      return (
        <View style={s.centro}>
          <Text style={s.blocoTitulo} accessibilityRole="header">
            Não deu para carregar os seus pedidos
          </Text>
          <ErrorBanner message={pedidos.error.message} />
          <Button
            label="Tentar de novo"
            onPress={() => void pedidos.refetch()}
            loading={pedidos.isFetching}
          />
        </View>
      )
    }

    if (lista.length === 0) return vazio()

    return (
      <FlatList
        data={lista}
        keyExtractor={(pedido) => pedido.id}
        renderItem={({ item }) => (
          <CartaoDoPedido pedido={item} aoTocar={() => router.push(pedidoEm(item.id))} />
        )}
        style={s.lista}
        contentContainerStyle={s.listaConteudo}
        refreshControl={
          // A lista já se renova sozinha a cada minuto (ver `useMyRequests`),
          // mas quem está esperando alguém aceitar puxa a tela para baixo sem
          // pensar. Negar isso faria o app parecer travado justo na espera.
          <RefreshControl
            refreshing={puxando}
            onRefresh={() => void atualizarPuxando()}
            tintColor={theme.colors.primary}
            colors={[theme.colors.primary]}
            progressBackgroundColor={theme.colors.surface}
          />
        }
      />
    )
  }

  // A FlatList rola sozinha e não pode morar dentro de uma ScrollView. Os
  // outros três estados são texto solto numa View fixa — e quem aumenta a fonte
  // do sistema, como boa parte do público deste app, perde o botão do fim. Daí
  // a rolagem só quando não há lista.
  const temLista = !pedidos.isPending && !pedidos.isError && lista.length > 0

  return (
    <Screen scroll={!temLista}>
      <Title>Meus pedidos</Title>

      {corpo()}

      {temLista ? <Button label="Pedir um passeio ou uma visita" onPress={irParaNovoPedido} /> : null}

      <Button label="Voltar" variant="ghost" onPress={voltar} />
    </Screen>
  )
}

function CartaoDoPedido({
  pedido,
  aoTocar,
}: {
  pedido: ServiceRequest
  aoTocar: () => void
}): React.JSX.Element {
  const s = useStyles()

  const estado = descricaoDoStatus(pedido.status)
  const aparencia = ESTADO[pedido.status]

  // O nome vem do snapshot, não da tabela de animais: é o nome que valia quando
  // o serviço foi pedido, e o animal pode ter sido renomeado ou arquivado
  // depois. O histórico precisa continuar dizendo quem foi atendido.
  const nome = nomeDoAnimalNoPedido(pedido.pet_snapshot) ?? 'Seu animal'
  const servico = servicoPorExtenso(pedido.service, pedido.duration_minutes)
  const quando = quandoPorExtenso(pedido.scheduled_at)
  const explicacao = aparencia.explicaNaLista ? estado.explicacao : null

  const horario = quando ?? 'Não conseguimos ler o horário deste serviço.'

  return (
    <Pressable
      onPress={aoTocar}
      accessibilityRole="button"
      // O leitor de tela anuncia o cartão inteiro numa frase só; sem isto ele
      // leria etiqueta, nome, serviço, horário e explicação como cinco paradas
      // separadas — e a primeira delas, o estado, se perderia no meio.
      accessibilityLabel={`${estado.titulo}. ${nome}, ${servico}, ${horario}${
        explicacao === null ? '' : ` ${explicacao}`
      }`}
      accessibilityHint="Toque para ver este pedido por dentro."
      style={({ pressed }) => [s.cartao, pressed && s.cartaoPressionado]}
    >
      <View style={s.linha}>
        {/* O texto precisa de um pai flexível, senão o nome longo escapa da
            largura da tela em vez de quebrar. */}
        <View style={s.textos}>
          <Etiqueta tom={aparencia.tom} texto={estado.titulo} />

          <Text style={s.nome} numberOfLines={2}>
            {nome}
          </Text>
          <Text style={s.servico} numberOfLines={2}>
            {servico}
          </Text>
          {/* O horário sai em hora local, a mesma que a pessoa escolheu no
              aparelho dela — `scheduled_at` é timestamptz e guarda o instante,
              não o texto. É a linha que ela usa para conferir se marcou o dia
              certo, então tem peso de informação, não de legenda. */}
          <Text style={s.quando}>{horario}</Text>
        </View>

        {/* Etiqueta, nome e horário desenham um cartão de informação, não um
            botão: sem esta seta o único sinal de que dá para tocar aparece
            depois do toque. O leitor de tela já ouve o accessibilityHint do
            Pressable e não precisa ouvir um chevron. */}
        <Text style={s.seta} accessibilityElementsHidden importantForAccessibility="no">
          ›
        </Text>
      </View>

      {explicacao === null ? null : <Text style={s.explicacao}>{explicacao}</Text>}
    </Pressable>
  )
}

/**
 * O estado, escrito e colorido.
 *
 * A cor nunca está sozinha — o título diz a mesma coisa por extenso, para quem
 * não distingue as duas e para quem lê no sol.
 */
function Etiqueta({ tom, texto }: { tom: Tom; texto: string }): React.JSX.Element {
  const s = useStyles()

  const fundo = {
    neutro: s.etiquetaNeutra,
    atencao: s.etiquetaAtencao,
    ok: s.etiquetaOk,
    falha: s.etiquetaFalha,
  }[tom]

  const cor = {
    neutro: s.etiquetaTextoNeutro,
    atencao: s.etiquetaTextoAtencao,
    ok: s.etiquetaTextoOk,
    falha: s.etiquetaTextoFalha,
  }[tom]

  return (
    <View style={[s.etiqueta, fundo]}>
      <Text style={[s.etiquetaTexto, cor]}>{texto}</Text>
    </View>
  )
}

/**
 * O nome do animal guardado em `pet_snapshot`.
 *
 * A coluna é `jsonb` e chega tipada como Json — qualquer forma é possível do
 * ponto de vista do compilador, mesmo que o trigger `assert_request_insert`
 * sempre monte o mesmo objeto. Devolve null em vez de arriscar um acesso que
 * derrubaria a lista inteira por causa de uma linha antiga.
 */
function nomeDoAnimalNoPedido(snapshot: ServiceRequest['pet_snapshot']): string | null {
  if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) return null

  const nome = snapshot['name']
  if (typeof nome !== 'string') return null

  const limpo = nome.trim()
  return limpo === '' ? null : limpo
}

/** "Passeio de 1 hora", "Visita em casa de 30 minutos". */
function servicoPorExtenso(service: ServiceRequest['service'], minutos: number): string {
  const nome = nomeDoServico(service)
  const comMaiuscula = `${nome.charAt(0).toUpperCase()}${nome.slice(1)}`

  const duracao = duracaoPorExtenso(minutos)
  return duracao === null ? comMaiuscula : `${comMaiuscula} de ${duracao}`
}

/**
 * 30 vira "30 minutos", 60 vira "1 hora", 90 vira "1 hora e 30 minutos".
 *
 * Quais durações existem é a tabela `pricing` que diz, e por isso nenhuma delas
 * está escrita aqui: a função converte o número que vier. Devolve null para o
 * que não é duração de verdade — aí o cartão diz só o nome do serviço, que
 * ainda é informação certa.
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
 * O horário do serviço em hora local, do jeito que se fala em Foz.
 *
 * O que chega é o ISO com fuso do `timestamptz`; o `Date` o converte para o
 * fuso do aparelho, que é o mesmo em que a pessoa escolheu o horário. Todas as
 * contas daqui usam os componentes locais — usar UTC trocaria o dia de qualquer
 * serviço marcado depois das 21h.
 *
 * Sem `toLocaleString` pelo mesmo motivo que `reais` não usa `Intl`: o Hermes
 * entrega o ICU em versões diferentes conforme o aparelho, e a mesma data sai
 * escrita de dois jeitos em dois celulares.
 */
function quandoPorExtenso(iso: string): string | null {
  const data = new Date(iso)
  if (Number.isNaN(data.getTime())) return null

  return `${diaPorExtenso(data)}, às ${horaPorExtenso(data)}`
}

function diaPorExtenso(data: Date): string {
  const diferenca = diasDeCalendario(data, new Date())

  if (diferenca === 0) return 'Hoje'
  if (diferenca === 1) return 'Amanhã'
  if (diferenca === -1) return 'Ontem'

  const dia = `${data.getDate()}`.padStart(2, '0')
  const mes = `${data.getMonth() + 1}`.padStart(2, '0')
  return `${dia}/${mes}/${data.getFullYear()}`
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

/** 15h30, e 8h quando não há minutos. Relógio de 24 horas, como se fala aqui. */
function horaPorExtenso(data: Date): string {
  const hora = data.getHours()
  const minuto = data.getMinutes()

  return minuto === 0 ? `${hora}h` : `${hora}h${`${minuto}`.padStart(2, '0')}`
}

/**
 * Um cartão por pedido, mais a etiqueta de cada um: a folha é criada uma vez
 * por tema, e não uma vez por linha da lista.
 */
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
    // Ocupa o que sobra entre o título e os botões do rodapé, e deixa o rodapé
    // fixo: o botão de pedir não some quando a lista é longa.
    lista: { flex: 1 },
    listaConteudo: { gap: spacing.md, paddingBottom: spacing.sm },

    centro: { flex: 1, justifyContent: 'center', gap: spacing.md },
    seta: {
      color: c.textDim,
      fontSize: font.size.xl,
      lineHeight: font.line.xl,
      fontWeight: font.weight.medium,
    },
    blocoTitulo: {
      color: c.text,
      fontSize: font.size.lg,
      lineHeight: font.line.lg,
      fontWeight: font.weight.bold,
    },

    cartao: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.divider,
      borderRadius: radius.lg,
      padding: spacing.md,
      gap: spacing.md,
    },
    cartaoPressionado: { backgroundColor: c.primarySoft, borderColor: c.primary },

    linha: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    textos: { flex: 1, gap: spacing.xs },

    etiqueta: {
      alignSelf: 'flex-start',
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
    },
    // Cinza é a ausência de aviso, e é o lugar de `requested`: o pedido está no
    // ar, ninguém precisa fazer nada, e cor de alerta aqui só geraria aflição.
    etiquetaNeutra: { backgroundColor: c.surfaceAlt },
    etiquetaAtencao: { backgroundColor: c.accentSoft },
    etiquetaOk: { backgroundColor: c.primarySoft },
    etiquetaFalha: { backgroundColor: c.dangerSoft },
    etiquetaTexto: {
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
      fontWeight: font.weight.bold,
    },
    etiquetaTextoNeutro: { color: c.text },
    etiquetaTextoAtencao: { color: c.accent },
    etiquetaTextoOk: { color: c.primary },
    etiquetaTextoFalha: { color: c.danger },

    nome: {
      color: c.text,
      fontSize: font.size.md,
      lineHeight: font.line.md,
      fontWeight: font.weight.bold,
    },
    servico: {
      color: c.textDim,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
    },
    // Peso de informação, não de legenda: é por esta linha que a pessoa confere
    // se marcou o dia e a hora que queria.
    quando: {
      color: c.text,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
      fontWeight: font.weight.medium,
    },

    explicacao: {
      color: c.textDim,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
    },
  })
}
