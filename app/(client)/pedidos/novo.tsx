/**
 * O pedido de serviço — a tela por onde entra o dinheiro.
 *
 * Quatro passos, um de cada vez: qual animal, quando, onde, e conferir. A
 * ordem não é estética. Cada passo só existe por causa do anterior:
 *
 *   o ANIMAL decide o serviço (cão → passeio, gato → visita em casa, ADR
 *   decisão 1) e é quem pode barrar o pedido inteiro pela vacina vencida. Saber
 *   disso no primeiro toque é ruim; saber depois de escolher data, hora e
 *   endereço é perder o trabalho todo;
 *
 *   o QUANDO define a duração, e é a duração que escolhe a linha de `pricing` —
 *   ou seja, o valor só pode ser mostrado depois deste passo;
 *
 *   o ONDE é o único passo que pode não ter saída: sem latitude e longitude o
 *   banco não aceita o pedido (`address_geog` é not null), e não existe serviço
 *   de geocodificação pago neste projeto;
 *
 *   o CONFERIR é o último lugar onde um engano ainda é de graça.
 *
 * O QUE ESTA TELA NÃO FAZ, e é de propósito:
 *
 *   não calcula preço nem comissão. O valor vem de `usePrecoVigente`, que lê a
 *   tabela `pricing`; quem cobra é o trigger `assert_request_insert`, com a
 *   mesma linha. Não há um número em reais escrito neste arquivo, e quando a
 *   consulta do preço falha a tela diz que não sabe o valor e não deixa pedir —
 *   pedir sem saber quanto custa é pedir no escuro;
 *
 *   não carimba a versão dos Termos. A caixa de aceite nasce desmarcada e o que
 *   ela produz fica aqui; `terms_version` é escrito pelo servidor (ADR decisão
 *   8). O que a tela deve é MOSTRAR qual versão está sendo aceita;
 *
 *   não reescreve mensagem de erro. Todas chegam prontas de `@/api/requests` e
 *   de `@/lib/localizacao`.
 *
 * E o cuidado que atravessa a tela inteira: FUSO HORÁRIO. O seletor devolve um
 * `Date` no fuso do aparelho; todo horário é remontado com os componentes
 * LOCAIS (ver `comDia` e `comHora`) e só vira texto ISO na hora de enviar. A
 * hora escolhida é escrita de volta por extenso, com dia da semana e ano, em
 * dois lugares diferentes — é a única defesa contra marcar o passeio para outro
 * horário, e o erro de fuso só apareceria no dia, com a pessoa fora de casa.
 */
import * as React from 'react'
import { Alert, Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useNavigation, useRouter } from 'expo-router'
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker'

import type { Pet } from '@/api/pets'
import type { Pricing } from '@/api/pricing'
import { Body, Button, ErrorBanner, Loading, Screen, TextField, Title } from '@/components/ui'
import { useMyPets } from '@/hooks/usePets'
import {
  useCreateRequest,
  usePrecoVigente,
  useTermosAtivos,
  useUltimoEndereco,
} from '@/hooks/useRequests'
import { coordenadaDoEndereco, minhaLocalizacao, type Coordenada } from '@/lib/localizacao'
import { useTheme, type Theme } from '@/lib/theme'
import { vacinaEstaVencida } from '@/schemas/pet'
import { nomeDoServico, reais, requestSchema, servicoDoAnimal } from '@/schemas/request'

/** As telas vizinhas, juntas aqui em cima para o dia em que o caminho mudar. */
const INICIO = '/(client)/inicio'
const MEUS_PEDIDOS = '/(client)/pedidos'
const CADASTRO_DE_ANIMAL = '/(client)/pets/novo'
const animalEm = (id: string) => `/(client)/pets/${id}` as const
const pedidoEm = (id: string) => `/(client)/pedidos/${id}` as const

/**
 * Quanto tempo à frente a tela exige, em minutos.
 *
 * O banco recusa horário a 15 minutos ou menos (`assert_request_insert`), e
 * essa é a régua do servidor — não a da pessoa. Marcar para daqui a 16 minutos
 * passaria pelo trigger e não serviria para ninguém: entre o toque em confirmar
 * e o passeador tocando a campainha existem um pedido para ser visto, um aceite,
 * dez minutos de prazo de pagamento e a travessia de Foz de moto.
 *
 * Uma hora é a folga que torna o pedido possível de atender, e ainda deixa a
 * tela bem longe da recusa do banco — até porque o relógio que o trigger usa é
 * o do servidor, e o desta tela é o do celular.
 */
const FOLGA_MINIMA_MIN = 60

/**
 * As durações que a tela PERGUNTA à tabela de preços — não as que ela oferece.
 *
 * Quem decide o que aparece é `pricing`: cada uma destas vira uma consulta, e
 * só as que voltarem com preço vigente viram opção na tela. Hoje o banco tem
 * uma linha de 60 minutos por serviço, então a tela mostra uma opção só; no dia
 * em que alguém publicar a de 30, ela aparece sozinha, sem tocar neste arquivo.
 *
 * A lista existe porque não há, hoje, função de API que liste as durações
 * disponíveis — ver a `duvidas` da entrega. Número de minutos não é valor em
 * reais: o que a decisão 2 do ADR proíbe é o app saber preço, e preço nenhum
 * está escrito aqui.
 */
const DURACOES_CANDIDATAS = [30, 60, 90] as const

type Passo = 'animal' | 'quando' | 'onde' | 'conferir'

const PASSOS: readonly { passo: Passo; titulo: string }[] = [
  { passo: 'animal', titulo: 'Qual animal' },
  { passo: 'quando', titulo: 'Quando' },
  { passo: 'onde', titulo: 'Onde' },
  { passo: 'conferir', titulo: 'Conferir e pedir' },
]

/**
 * De onde veio a coordenada. Não é enfeite de tela: é ela que decide o que
 * acontece quando a pessoa mexe no endereço escrito — ver `escreverEndereco`.
 */
type Origem = 'anterior' | 'aparelho' | 'digitado'

/** Uma duração que tem preço vigente, com o preço que o banco devolveu. */
type OpcaoDeDuracao = { minutos: number; preco: Pricing }

/** Recado do passo do endereço: `grave` vira faixa de erro, o resto vira aviso. */
type Recado = { grave: boolean; texto: string }

export default function NovoPedido(): React.JSX.Element {
  const router = useRouter()
  const navigation = useNavigation()
  const s = useStyles()

  const animais = useMyPets()
  const ultimo = useUltimoEndereco()
  const termos = useTermosAtivos()
  const criar = useCreateRequest()

  const [passo, setPasso] = React.useState<Passo>('animal')
  const [petId, setPetId] = React.useState<string | null>(null)
  const [duracaoManual, setDuracaoManual] = React.useState<number | null>(null)

  // O horário mora num Date local do começo ao fim. Virar texto ISO é a última
  // coisa que acontece com ele, dentro de `confirmar`.
  const [quando, setQuando] = React.useState<Date | null>(null)
  const [seletor, setSeletor] = React.useState<'date' | 'time' | null>(null)
  const [sugestao, setSugestao] = React.useState(proximoHorarioPossivel)

  const [enderecoTexto, setEnderecoTexto] = React.useState('')
  const [coordenada, setCoordenada] = React.useState<Coordenada | null>(null)
  const [origem, setOrigem] = React.useState<Origem | null>(null)
  const [buscandoNoAparelho, setBuscandoNoAparelho] = React.useState(false)
  const [procurandoPeloTexto, setProcurandoPeloTexto] = React.useState(false)
  const [recado, setRecado] = React.useState<Recado | null>(null)

  // Nasce falsa e só a mão da pessoa muda isso. Caixa pré-marcada não é aceite.
  const [aceitouTermos, setAceitouTermos] = React.useState(false)
  const [avisoDosTermos, setAvisoDosTermos] = React.useState<string | null>(null)

  const [erros, setErros] = React.useState<Record<string, string>>({})
  const [pedidoCriado, setPedidoCriado] = React.useState<string | null>(null)

  const animal = animais.data?.find((a) => a.id === petId) ?? null
  const servico = animal === null ? null : servicoDoAnimal(animal.species)

  // Três chamadas fixas, sempre na mesma ordem: hook não se chama dentro de um
  // laço que muda de tamanho. Enquanto não houver animal escolhido, `servico` é
  // nulo e as três consultas ficam desligadas — ninguém vai ao servidor antes
  // de haver o que perguntar.
  const preco30 = usePrecoVigente(servico, 30)
  const preco60 = usePrecoVigente(servico, 60)
  const preco90 = usePrecoVigente(servico, 90)

  const consultasDePreco = [
    { minutos: DURACOES_CANDIDATAS[0], consulta: preco30 },
    { minutos: DURACOES_CANDIDATAS[1], consulta: preco60 },
    { minutos: DURACOES_CANDIDATAS[2], consulta: preco90 },
  ]

  const opcoes: OpcaoDeDuracao[] = []
  for (const { minutos, consulta } of consultasDePreco) {
    const preco = consulta.data
    // `undefined` é "ainda não respondeu ou falhou" e `null` é "não existe linha
    // vigente". Nenhum dos dois vira opção na tela.
    if (preco !== undefined && preco !== null) opcoes.push({ minutos, preco })
  }

  const precosCarregando = consultasDePreco.some((c) => c.consulta.isPending)
  const precosBuscando = consultasDePreco.some((c) => c.consulta.isFetching)
  const erroDePreco = consultasDePreco.find((c) => c.consulta.isError)?.consulta.error ?? null

  const duracao = duracaoEscolhida(duracaoManual, opcoes)
  const opcaoEscolhida = opcoes.find((o) => o.minutos === duracao) ?? null

  const enderecoLimpo = enderecoTexto.trim()

  // 'pagar_antes' vem da RPC (`hint`) e a mensagem já chega pronta de
  // `@/api/requests`. O que a tela faz com a dica é parar de oferecer o botão:
  // tocar de novo levaria à mesma recusa, e o caminho de saída não está nesta
  // tela nem neste épico.
  const bloqueadoPorDivida = dicaDoErro(criar.error) === 'pagar_antes'

  const pendencias = oQueFalta({
    animal,
    quando,
    opcaoEscolhida,
    enderecoLimpo,
    coordenada,
    temTermos: termos.temTermos,
    termosCarregando: termos.isPending,
    aceitouTermos,
  })

  /**
   * O botão de voltar do aparelho não pode jogar o pedido fora em silêncio.
   *
   * O _layout desliga o cabeçalho, então não existe seta desenhada pelo sistema
   * — quem está acostumado com WhatsApp usa o botão (ou o gesto) de voltar do
   * aparelho. Ele desmonta a rota, e TUDO o que foi preenchido vive em useState
   * desta tela: animal, duração, dia, hora, endereço, coordenada, aceite. Um
   * toque sem querer no passo 4 recomeçava do zero.
   *
   * O aviso só aparece quando há o que perder, e nunca depois que o pedido saiu
   * — aí a tela já é outra e sair é o caminho certo.
   */
  const temRascunho =
    pedidoCriado === null && (petId !== null || quando !== null || enderecoLimpo !== '')

  React.useEffect(() => {
    if (!temRascunho) return

    return navigation.addListener('beforeRemove', (evento) => {
      evento.preventDefault()
      Alert.alert(
        'Sair sem pedir?',
        'Você já preencheu parte do pedido. Se sair agora, o que você escreveu se perde e da próxima vez começa do começo.',
        [
          { text: 'Continuar preenchendo', style: 'cancel' },
          {
            text: 'Sair sem pedir',
            style: 'destructive',
            onPress: () => navigation.dispatch(evento.data.action),
          },
        ],
      )
    })
  }, [navigation, temRascunho])

  /** Volta para de onde veio, ou para a casa do tutor quando não há de onde voltar. */
  function sair(): void {
    if (router.canGoBack()) {
      router.back()
      return
    }
    router.replace(INICIO)
  }

  function limparErro(campo: string): void {
    setErros((antigos) => {
      if (antigos[campo] === undefined) return antigos
      const novos = { ...antigos }
      delete novos[campo]
      return novos
    })
  }

  function escolherAnimal(escolhido: Pet): void {
    setPetId(escolhido.id)
    limparErro('petId')

    // A duração escolhida à mão não atravessa a troca de animal: cão e gato
    // podem ter linhas de preço diferentes em `pricing`, e carregar a escolha
    // antiga deixaria marcada na tela uma duração que o outro serviço não tem.
    setDuracaoManual(null)
  }

  // ---------------------------------------------------------------------------
  // Quando
  // ---------------------------------------------------------------------------

  function abrirSeletor(modo: 'date' | 'time'): void {
    // A sugestão é recalculada na abertura, e não a cada render: com ela
    // mudando debaixo da roda do iOS, o seletor pularia enquanto a pessoa gira.
    if (quando === null) setSugestao(proximoHorarioPossivel())
    setSeletor(modo)
  }

  function aoMexerNoSeletor(evento: DateTimePickerEvent, escolhido?: Date): void {
    // 'dismissed' é o Cancelar do diálogo do Android, e cancelar não pode mudar
    // o que já estava escolhido.
    if (evento.type !== 'set' || escolhido === undefined) {
      setSeletor(null)
      return
    }

    const base = quando ?? sugestao
    setQuando(seletor === 'time' ? comHora(base, escolhido) : comDia(base, escolhido))
    limparErro('quando')

    // No Android o diálogo é do sistema e já se fechou sozinho antes deste
    // aviso chegar. No iOS a roda continua na tela até o toque em "Pronto",
    // porque lá cada giro dispara um 'set' — fechar aqui tiraria o seletor da
    // tela no primeiro movimento do dedo.
    if (Platform.OS !== 'ios') setSeletor(null)
  }

  // ---------------------------------------------------------------------------
  // Onde
  // ---------------------------------------------------------------------------

  function escreverEndereco(texto: string): void {
    setEnderecoTexto(texto)
    setRecado(null)
    limparErro('enderecoTexto')

    // Ponto vindo do último pedido ou do geocodificador descreve UM endereço, e
    // o endereço acabou de mudar. Guardar a coordenada antiga seria guardar a
    // casa antiga: o pedido nasceria certinho, o passeador tocaria a campainha
    // do lugar errado, e ninguém descobriria antes do dia.
    //
    // O ponto do aparelho é outra coisa — ele diz onde a PESSOA está, e ela
    // continua no mesmo lugar depois de acrescentar "apartamento 2" ou "portão
    // azul" na descrição. Esse não se perde por causa de um complemento.
    //
    // Mas complemento não é reescrita. Ela pode marcar o ponto em casa e depois
    // apagar tudo para escrever o endereço da mãe, onde o gato vai ficar — e aí
    // o pedido nascia com o texto de um lugar e o ponto de outro, sem erro
    // nenhum aparecer. `aindaDescreveOMesmoLugar` separa os dois casos: manter
    // o começo do que estava escrito é acrescentar; trocar o começo é outra casa.
    if (origem === 'anterior' || origem === 'digitado') {
      setCoordenada(null)
      setOrigem(null)
      return
    }

    if (origem === 'aparelho' && !aindaDescreveOMesmoLugar(enderecoTexto, texto)) {
      setCoordenada(null)
      setOrigem(null)
    }
  }

  function reaproveitarEndereco(comOTextoAnterior: boolean): void {
    const anterior = ultimo.data
    if (anterior === undefined || anterior === null) return

    if (comOTextoAnterior) setEnderecoTexto(anterior.texto)
    setCoordenada({ lat: anterior.lat, lng: anterior.lng })
    setOrigem('anterior')
    setRecado(null)
    limparErro('enderecoTexto')
  }

  async function usarOndeEstou(): Promise<void> {
    setRecado(null)
    setBuscandoNoAparelho(true)

    try {
      const achada = await minhaLocalizacao()
      setCoordenada(achada)
      setOrigem('aparelho')
      limparErro('enderecoTexto')
    } catch (erro) {
      // `minhaLocalizacao` erra sempre com AppError, e cada mensagem dela já
      // diz o próximo passo. Reescrever aqui só pioraria.
      setRecado({ grave: true, texto: mensagemDoErro(erro) })
    } finally {
      setBuscandoNoAparelho(false)
    }
  }

  async function procurarPeloTexto(): Promise<void> {
    setRecado(null)
    setProcurandoPeloTexto(true)

    try {
      const achada = await coordenadaDoEndereco(enderecoTexto)

      if (achada === null) {
        // Voltar vazio é o comportamento normal no Android sem chave do Google,
        // não defeito — e a pessoa não pode achar que quebrou alguma coisa.
        setRecado({
          grave: false,
          texto:
            'Não conseguimos achar este endereço no mapa. Isso é comum e não é erro seu. Se você estiver no local do serviço agora, use o botão acima; se não, você pode voltar aqui quando estiver.',
        })
        return
      }

      setCoordenada(achada)
      setOrigem('digitado')
      limparErro('enderecoTexto')
    } finally {
      setProcurandoPeloTexto(false)
    }
  }

  // ---------------------------------------------------------------------------
  // Conferir e pedir
  // ---------------------------------------------------------------------------

  function abrirTermos(url: string): void {
    setAvisoDosTermos(null)
    void Linking.openURL(url).catch(() => {
      setAvisoDosTermos('Não foi possível abrir o texto dos Termos neste aparelho.')
    })
  }

  function confirmar(): void {
    if (animal === null || quando === null || coordenada === null || opcaoEscolhida === null) return

    const resultado = requestSchema.safeParse({
      petId: animal.id,
      service: servicoDoAnimal(animal.species),
      duracaoMin: opcaoEscolhida.minutos,
      enderecoTexto,
      lat: coordenada.lat,
      lng: coordenada.lng,
      // AQUI, e só aqui, o horário deixa de ser um Date local. `toISOString`
      // escreve o mesmo instante em UTC, e a coluna é timestamptz: o Postgres
      // guarda o instante, não o texto.
      quando: quando.toISOString(),
      aceitouTermos,
    })

    if (!resultado.success) {
      setErros(errosPorCampo(resultado.error.issues))
      // Sem isto o erro do envio anterior fica na tela enquanto a pessoa
      // conserta alguma coisa, e parece que o conserto não adiantou.
      criar.reset()
      return
    }

    setErros({})

    // `aceitouTermos` fica para trás de propósito: o servidor não recebe aceite
    // nenhum, ele carimba `terms_version` lendo a linha ativa de `terms`.
    criar.mutate(
      {
        petId: resultado.data.petId,
        service: resultado.data.service,
        duracaoMin: resultado.data.duracaoMin,
        enderecoTexto: resultado.data.enderecoTexto,
        lat: resultado.data.lat,
        lng: resultado.data.lng,
        quando: resultado.data.quando,
      },
      { onSuccess: (id) => setPedidoCriado(id) },
    )
  }

  // ---------------------------------------------------------------------------
  // Os quatro passos
  // ---------------------------------------------------------------------------

  function passoDoAnimal(): React.JSX.Element {
    if (animais.isPending) return <Loading />

    if (animais.isError) {
      return (
        <>
          <Text style={s.grupoTitulo} accessibilityRole="header">
            Não deu para carregar os seus animais
          </Text>
          <ErrorBanner message={animais.error.message} />
          <Button
            label="Tentar de novo"
            onPress={() => void animais.refetch()}
            loading={animais.isFetching}
          />
        </>
      )
    }

    const lista = animais.data ?? []

    if (lista.length === 0) {
      return (
        <>
          <Text style={s.grupoTitulo} accessibilityRole="header">
            Você ainda não tem nenhum animal cadastrado
          </Text>
          <Body>
            É o animal cadastrado que o passeador vai atender, e é no cadastro dele que fica a
            data da vacina antirrábica — sem ela não dá para pedir passeio nem visita.
          </Body>
          <Button
            label="Cadastrar meu animal"
            onPress={() => router.push(CADASTRO_DE_ANIMAL)}
          />
        </>
      )
    }

    const impedidos = lista.filter((a) => vacinaEstaVencida(a.rabies_valid_until))
    const nenhumLiberado = impedidos.length === lista.length

    return (
      <>
        <Text style={s.grupoTitulo} accessibilityRole="header">
          Quem vai ser atendido?
        </Text>
        <Text style={s.grupoAjuda}>
          O serviço vem junto com o animal e não é você que escolhe: cachorro é passeio na rua,
          gato é visita em casa.
        </Text>

        <View style={s.grupo} accessibilityRole="radiogroup">
          {lista.map((candidato) => (
            <LinhaDoAnimal
              key={candidato.id}
              animal={candidato}
              escolhido={candidato.id === petId}
              aoEscolher={() => escolherAnimal(candidato)}
              aoAbrirCadastro={() => router.push(animalEm(candidato.id))}
            />
          ))}
        </View>

        {nenhumLiberado ? (
          <Aviso
            titulo="Nenhum animal está com a vacina em dia"
            texto="Para pedir passeio ou visita, a antirrábica precisa estar válida. Abra o cadastro do animal e coloque a data da próxima dose que está na carteirinha — se ela venceu mesmo, renove com o veterinário e volte aqui depois."
          />
        ) : null}

        {/* Quem nunca pediu não tem endereço guardado, e o caminho que sobra no
            passo 3 é marcar o ponto estando no lugar. Descobrir isso lá, depois
            de escolher animal, duração e horário, é trabalho jogado fora — e a
            pessoa que está no serviço na hora de pedir não tem como terminar.
            Dizer aqui, no primeiro passo, custa uma frase. */}
        {!nenhumLiberado && ultimo.data == null && !ultimo.isPending ? (
          <Aviso
            titulo="Da primeira vez, peça estando no endereço"
            texto="No último passo o aplicativo precisa marcar no mapa onde o serviço vai acontecer, e este é o seu primeiro pedido — ainda não temos endereço guardado seu. O jeito mais simples é pedir estando na casa onde o animal fica. Do segundo pedido em diante, é um toque só."
          />
        ) : null}

        <Button
          label="Cadastrar outro animal"
          variant="ghost"
          onPress={() => router.push(CADASTRO_DE_ANIMAL)}
        />
      </>
    )
  }

  function passoDoQuando(): React.JSX.Element {
    const nome = animal?.name ?? 'seu animal'

    return (
      <>
        <Text style={s.grupoTitulo} accessibilityRole="header">
          Quanto tempo o serviço vai durar?
        </Text>

        {blocoDaDuracao()}

        <Text style={s.grupoTitulo} accessibilityRole="header">
          Que dia e que hora?
        </Text>
        <Text style={s.grupoAjuda}>
          Marque com pelo menos uma hora de folga: é o tempo de alguém ver o seu pedido, aceitar
          e chegar até você.
        </Text>

        <View style={s.grupo}>
          <Toque
            rotulo="Dia"
            valor={quando === null ? 'Escolher o dia' : diaCurto(quando)}
            escolhido={quando !== null}
            aoTocar={() => abrirSeletor('date')}
          />
          <Toque
            rotulo="Hora"
            valor={quando === null ? 'Escolher a hora' : horaCurta(quando)}
            escolhido={quando !== null}
            aoTocar={() => abrirSeletor('time')}
          />
        </View>

        {seletor !== null ? (
          <>
            <DateTimePicker
              value={quando ?? sugestao}
              mode={seletor}
              display={Platform.OS === 'ios' ? 'spinner' : 'default'}
              is24Hour
              // Só no calendário: no relógio o mínimo não é respeitado em todo
              // aparelho Android, e uma trava que funciona num celular e não no
              // outro é pior do que nenhuma. Quem cobra a folga é a conferência
              // abaixo, que vale nos dois.
              minimumDate={seletor === 'date' ? primeiroDiaPossivel() : undefined}
              onChange={aoMexerNoSeletor}
            />
            {Platform.OS === 'ios' ? (
              <Button label="Pronto" variant="ghost" onPress={() => setSeletor(null)} />
            ) : null}
          </>
        ) : null}

        {/* A frase que defende do erro de fuso. Escrita por extenso, com dia da
            semana e ano, porque "18/09 15:30" é fácil de ler errado — e o
            engano só apareceria no dia, com a pessoa fora de casa. */}
        {quando !== null ? (
          <View style={s.confere}>
            <Text style={s.confereRotulo}>Você escolheu</Text>
            <Text style={s.confereValor}>{dataPorExtenso(quando)}</Text>
            <Text style={s.confereNota}>
              Confira com calma: é neste horário que alguém vai buscar {nome}.
            </Text>
          </View>
        ) : null}

        {erros['quando'] !== undefined ? (
          <Text style={s.erroTexto} accessibilityLiveRegion="polite">
            {erros['quando']}
          </Text>
        ) : null}
      </>
    )
  }

  function blocoDaDuracao(): React.JSX.Element {
    if (precosCarregando) return <Body dim>Carregando as opções de tempo…</Body>

    if (opcoes.length === 0 && erroDePreco !== null) {
      return (
        <>
          <ErrorBanner message={erroDePreco.message} />
          <Body dim>
            Sem falar com o servidor não dá para saber quanto custa, e sem saber quanto custa
            não dá para pedir.
          </Body>
          <Button
            label="Tentar de novo"
            onPress={tentarPrecosDeNovo}
            loading={precosBuscando}
          />
        </>
      )
    }

    if (opcoes.length === 0) {
      return (
        <Aviso
          titulo="Este serviço está indisponível agora"
          texto="Não há valor publicado para este serviço no momento. O problema é nosso, não do seu cadastro. Tente de novo mais tarde."
        />
      )
    }

    // Uma opção só não é escolha: pedir um toque numa lista de um item faz
    // parecer que existe alternativa, e não existe. Ela já vem selecionada
    // (ver `duracaoEscolhida`) e a tela apenas informa.
    //
    // O VALOR ENTRA AQUI, e é o ramo que roda de verdade hoje — o banco tem uma
    // linha de 60 min por serviço. Sem ele, a pessoa escolhia dia, hora,
    // escrevia o endereço e autorizava a localização antes de descobrir quanto
    // ia pagar; o preço já estava carregado desde a escolha do animal e só não
    // era escrito na tela. Ninguém aceita isso num mercado, e aqui era pior.
    const primeira = opcoes[0]
    if (opcoes.length === 1 && primeira !== undefined) {
      return (
        <View style={s.confere}>
          <Text style={s.confereRotulo}>Duração e valor</Text>
          <Text style={s.confereValor}>
            {duracaoPorExtenso(primeira.minutos) ?? 'Duração única'} ·{' '}
            {reais(primeira.preco.priceCents)}
          </Text>
          <Text style={s.confereNota}>
            É a única duração oferecida hoje para{' '}
            {servico === null ? 'este serviço' : servicoComArtigo(servico)}. Você confere tudo
            de novo antes de confirmar.
          </Text>
        </View>
      )
    }

    return (
      <View style={s.grupo} accessibilityRole="radiogroup">
        {opcoes.map((opcao) => (
          <Escolha
            key={opcao.minutos}
            titulo={duracaoPorExtenso(opcao.minutos) ?? `${opcao.minutos} minutos`}
            // O valor de cada opção vem do banco, uma linha de `pricing` por
            // duração. Nenhum deles é conta feita aqui.
            detalhe={reais(opcao.preco.priceCents)}
            escolhida={duracao === opcao.minutos}
            aoTocar={() => setDuracaoManual(opcao.minutos)}
          />
        ))}
      </View>
    )
  }

  function tentarPrecosDeNovo(): void {
    for (const { consulta } of consultasDePreco) void consulta.refetch()
  }

  function passoDoOnde(): React.JSX.Element {
    const anterior = ultimo.data ?? null

    // `textoMudou` só faz sentido depois que existe texto escrito. Na chegada ao
    // passo o campo está VAZIO, e comparar vazio com o endereço anterior dava
    // "mudou" — o que escondia justamente o botão que preenche texto E
    // coordenada de uma vez, o caminho nº 1 do épico. Sobrava o botão do GPS,
    // que marca onde a pessoa está e a faz redigitar o endereço inteiro.
    const textoMudou =
      anterior !== null && enderecoLimpo !== '' && enderecoLimpo !== anterior.texto.trim()

    return (
      <>
        <Text style={s.grupoTitulo} accessibilityRole="header">
          Onde o serviço vai acontecer?
        </Text>

        <TextField
          label="Endereço, com rua e número"
          value={enderecoTexto}
          onChangeText={escreverEndereco}
          placeholder="Rua, número, bairro e o que ajuda a achar a porta"
          error={erros['enderecoTexto']}
        />
        <Body dim>
          Escreva como você explicaria para alguém que vai chegar de moto: o portão, a cor da
          casa, o número do apartamento.
        </Body>

        <Text style={s.grupoTitulo} accessibilityRole="header">
          E onde fica isso no mapa?
        </Text>

        {coordenada === null ? (
          <Text style={s.grupoAjuda}>
            O endereço escrito serve para a pessoa achar a sua porta; o ponto no mapa é o que faz
            o seu pedido aparecer para quem atende perto de você. Escolha um dos caminhos abaixo.
          </Text>
        ) : (
          <View style={s.confere}>
            <Text style={s.confereRotulo}>Já sabemos onde fica</Text>
            <Text style={s.confereValor}>{explicacaoDaOrigem(origem)}</Text>
          </View>
        )}

        {/* UM botão, não dois que se revezam. Eram dois, e trocar um pelo outro
            enquanto a pessoa digitava movia tudo o que vem abaixo — inclusive o
            botão do aparelho, que subia para o lugar do que sumiu. Quem toca
            duas vezes, que é costume de muita gente, marcava no mapa o lugar
            onde está, que pode ser o trabalho.

            O rótulo muda porque a pergunta muda: com o campo vazio ou igual ao
            de antes, é reaproveitar; com o texto já reescrito, a pergunta que
            importa é se ainda é a mesma casa — e ela responde tocando, em vez de
            ignorar um aviso. */}
        {anterior !== null && origem !== 'anterior' ? (
          <Button
            label={
              textoMudou
                ? 'É a mesma casa do meu último pedido'
                : 'Usar o endereço do meu último pedido'
            }
            variant="ghost"
            onPress={() => reaproveitarEndereco(!textoMudou)}
          />
        ) : null}

        <Button
          label="Estou neste endereço agora"
          variant="ghost"
          loading={buscandoNoAparelho}
          // A autorização de localização é pedida dentro de `minhaLocalizacao`,
          // no toque — nunca na abertura da tela.
          onPress={() => void usarOndeEstou()}
        />
        <Body dim>
          Isso marca no mapa o lugar onde o seu celular está neste momento. Use só se você
          estiver na casa onde o serviço vai acontecer.
        </Body>

        {enderecoLimpo.length >= 8 ? (
          <Button
            label="Procurar pelo endereço que escrevi"
            variant="ghost"
            loading={procurandoPeloTexto}
            onPress={() => void procurarPeloTexto()}
          />
        ) : null}

        {recado !== null ? (
          recado.grave ? (
            <ErrorBanner message={recado.texto} />
          ) : (
            <Aviso texto={recado.texto} />
          )
        ) : null}

        {/* O bloco existe nos dois estados em vez de desaparecer quando a
            coordenada chega. Sumindo, ele levava junto uns 120pt e puxava o
            botão Continuar para cima no mesmo toque que resolveu o endereço —
            bem embaixo do dedo que ainda estava descendo. */}
        {coordenada === null ? (
          <Aviso
            titulo="Ainda falta o ponto no mapa"
            texto="Não é defeito do aplicativo: nós não temos como adivinhar onde fica um endereço só de ler o que está escrito, e por isso precisamos que você diga. Enquanto faltar, o pedido não pode ser confirmado — e se você não estiver no endereço agora, dá para voltar aqui quando estiver."
          />
        ) : (
          <Aviso
            titulo="Pronto, o endereço está completo"
            texto="Temos o endereço escrito, que é o que a pessoa lê para achar a sua porta, e o ponto no mapa, que é o que faz o seu pedido aparecer para quem atende perto de você. Se este não for o lugar certo, dá para trocar os dois aqui mesmo antes de continuar."
          />
        )}
      </>
    )
  }

  function passoDeConferir(): React.JSX.Element {
    if (animal === null) return <Body>Volte e escolha o animal.</Body>

    const servicoDele = servicoDoAnimal(animal.species)
    const preco = opcaoEscolhida?.preco ?? null
    const versao = termos.data?.version ?? null
    const linkDosTermos = termos.data?.bodyUrl ?? null

    return (
      <>
        <Text style={s.grupoTitulo} accessibilityRole="header">
          Confira antes de pedir
        </Text>

        <View style={s.resumo}>
          <LinhaDoResumo
            rotulo="Animal"
            valor={animal.name}
            aoTrocar={() => setPasso('animal')}
            rotuloDoToque="Trocar o animal"
          />
          <LinhaDoResumo
            rotulo="Serviço"
            valor={servicoPorExtenso(servicoDele, opcaoEscolhida?.minutos ?? null)}
            aoTrocar={() => setPasso('quando')}
            rotuloDoToque="Trocar a duração"
          />
          <LinhaDoResumo
            rotulo="Dia e hora"
            valor={quando === null ? 'Falta escolher' : dataPorExtenso(quando)}
            aoTrocar={() => setPasso('quando')}
            rotuloDoToque="Trocar o dia e a hora"
          />
          <LinhaDoResumo
            rotulo="Endereço"
            valor={enderecoLimpo === '' ? 'Falta escrever' : enderecoLimpo}
            detalhe={coordenada === null ? 'Falta o ponto no mapa' : explicacaoDaOrigem(origem)}
            aoTrocar={() => setPasso('onde')}
            rotuloDoToque="Trocar o endereço"
          />
        </View>

        {/* O valor. Vem da tabela `pricing` pelo servidor; nenhuma conta é feita
            neste arquivo, e quando ele não pôde ser lido a tela diz isso em vez
            de mostrar um número qualquer. */}
        {preco !== null ? (
          <View style={s.valorBloco}>
            <Text style={s.valorRotulo}>Valor do serviço</Text>
            <Text style={s.valor}>{reais(preco.priceCents)}</Text>
            <Text style={s.valorNota}>
              Nada é cobrado agora. Você só paga depois que alguém aceitar o seu pedido.
            </Text>
          </View>
        ) : (
          <Aviso
            titulo="Não sabemos o valor deste serviço agora"
            texto="Sem o valor não dá para pedir — você não vai confirmar um serviço sem saber quanto ele custa. Volte um passo e tente de novo."
          />
        )}

        <Text style={s.grupoTitulo} accessibilityRole="header">
          Termos de Uso
        </Text>

        {termos.isPending ? <Body dim>Carregando os Termos de Uso…</Body> : null}

        {termos.isError ? (
          <>
            <ErrorBanner message={termos.error.message} />
            <Button
              label="Tentar carregar os Termos de novo"
              variant="ghost"
              onPress={() => void termos.refetch()}
              loading={termos.isFetching}
            />
          </>
        ) : null}

        {!termos.isPending && !termos.isError && versao === null ? (
          <Aviso
            titulo="Não há Termos publicados no momento"
            texto="Sem eles não dá para pedir o serviço. Isso é problema nosso e não do seu cadastro — tente de novo mais tarde."
          />
        ) : null}

        {versao !== null ? (
          <>
            <Caixa
              marcada={aceitouTermos}
              aoTocar={() => setAceitouTermos((antes) => !antes)}
              titulo={`Li e aceito os Termos de Uso, versão ${versao}`}
              detalhe="É esta versão que fica guardada dentro deste pedido."
            />

            {linkDosTermos !== null ? (
              <Button
                label="Ler os Termos de Uso"
                variant="ghost"
                onPress={() => abrirTermos(linkDosTermos)}
              />
            ) : (
              // terms.ts é explícito: NUNCA montar um botão de leitura que não
              // abre nada. Sem link, o que a tela pode fazer é não esconder isso.
              <Body dim>
                O texto da versão {versao} ainda não está publicado para leitura, e sem ele você
                está aceitando uma coisa que não pode ler. Se preferir esperar, é o seu direito:
                peça o texto para a gente antes de aceitar. Se seguir agora, fica registrado
                neste pedido que a versão aceita foi a {versao}, e é essa que vale para ele — as
                versões seguintes não mudam o que foi combinado aqui.
              </Body>
            )}

            {avisoDosTermos !== null ? <Aviso texto={avisoDosTermos} /> : null}

            {erros['aceitouTermos'] !== undefined ? (
              <Text style={s.erroTexto} accessibilityLiveRegion="polite">
                {erros['aceitouTermos']}
              </Text>
            ) : null}
          </>
        ) : null}

        <Text style={s.grupoTitulo} accessibilityRole="header">
          O que acontece depois que você pedir
        </Text>
        <Body>
          Seu pedido fica à vista dos passeadores da região. Quando alguém aceitar, o horário
          fica guardado por 10 minutos para o pagamento, e é só aí que você paga.
        </Body>
        <Body dim>
          Enquanto ninguém aceita, você pode cancelar sem custo nenhum. O pedido fica na sua
          lista com o que está acontecendo com ele.
        </Body>

        {criar.error !== null ? <ErrorBanner message={criar.error.message} /> : null}

        {bloqueadoPorDivida ? (
          <Button label="Voltar para os meus pedidos" variant="ghost" onPress={() => router.replace(MEUS_PEDIDOS)} />
        ) : null}

        {/* Os erros do esquema vêm todos para perto do botão, e não para os
            campos: os campos ficaram nos passos anteriores, fora da tela. O caso
            real aqui é o horário que envelheceu enquanto ela preenchia o resto. */}
        {Object.keys(erros).length > 0 ? (
          <View style={s.aviso} accessibilityLiveRegion="assertive">
            <Text style={s.avisoTitulo}>Falta acertar uma coisa antes de pedir</Text>
            {Object.values(erros).map((mensagem) => (
              <Text key={mensagem} style={s.avisoTexto}>
                • {mensagem}
              </Text>
            ))}
          </View>
        ) : null}

        {/* O botão vem ANTES da lista de pendências, ao contrário do que parece
            natural. Com a lista em cima, o último toque antes de pedir — marcar
            a caixa dos Termos — tirava uma linha da lista, o bloco encolhia e o
            botão subia uns 90pt. O toque seguinte, que era o de confirmar,
            caía embaixo do botão, no vazio. Nada acontecia, e ela não sabia por
            quê. Embaixo, a lista pode encolher à vontade: o botão não se mexe. */}
        <Button
          label={`Pedir ${servicoComArtigo(servicoDele)}`}
          onPress={confirmar}
          loading={criar.isPending}
          disabled={pendencias.length > 0 || bloqueadoPorDivida}
        />

        {/* Botão bloqueado sem dizer por quê é a pior tela possível: a pessoa
            toca, nada acontece, e ela sai do aplicativo. */}
        {pendencias.length > 0 && !bloqueadoPorDivida ? (
          <View style={s.aviso}>
            <Text style={s.avisoTitulo}>
              {pendencias.length === 1 ? 'Falta uma coisa' : `Faltam ${pendencias.length} coisas`}
            </Text>
            {pendencias.map((mensagem) => (
              <Text key={mensagem} style={s.avisoTexto}>
                • {mensagem}
              </Text>
            ))}
          </View>
        ) : null}
      </>
    )
  }

  // ---------------------------------------------------------------------------
  // A tela
  // ---------------------------------------------------------------------------

  if (pedidoCriado !== null) {
    return (
      <Confirmacao
        nomeDoAnimal={animal?.name ?? 'seu animal'}
        servico={servicoPorExtenso(
          animal === null ? 'walk' : servicoDoAnimal(animal.species),
          opcaoEscolhida?.minutos ?? null,
        )}
        quando={quando}
        endereco={enderecoLimpo}
        aoAcompanhar={() => router.replace(pedidoEm(pedidoCriado))}
        aoVerLista={() => router.replace(MEUS_PEDIDOS)}
      />
    )
  }

  const indice = PASSOS.findIndex((p) => p.passo === passo)
  const atual = PASSOS[indice] ?? PASSOS[0]
  const anterior = PASSOS[indice - 1] ?? null
  const proximo = PASSOS[indice + 1] ?? null

  const travas = travasDoPasso(passo, { animal, opcaoEscolhida, quando, enderecoLimpo, coordenada })

  function avancar(): void {
    if (travas !== null) {
      setErros(travas.erros)
      return
    }
    setErros({})
    if (proximo !== null) setPasso(proximo.passo)
  }

  return (
    <Screen scroll>
      <Title>
        {servico === null ? 'Pedir um serviço' : `Pedir ${servicoComArtigo(servico)}`}
      </Title>

      <Text style={s.passoRotulo} accessibilityRole="header">
        Passo {indice + 1} de {PASSOS.length} · {atual?.titulo ?? ''}
      </Text>

      {passo === 'animal' ? passoDoAnimal() : null}
      {passo === 'quando' ? passoDoQuando() : null}
      {passo === 'onde' ? passoDoOnde() : null}
      {passo === 'conferir' ? passoDeConferir() : null}

      {proximo !== null ? (
        <>
          <Button
            label="Continuar"
            onPress={avancar}
            disabled={travas !== null && travas.bloqueia}
          />
          {/* Botão apagado sem motivo escrito é a tela em que a pessoa toca,
              nada acontece, e ela sai do aplicativo achando que quebrou. */}
          {travas !== null && travas.bloqueia && travas.motivo !== '' ? (
            <Body dim>{travas.motivo}</Body>
          ) : null}
        </>
      ) : null}

      {/* O caminho de volta fica visível em todos os passos, inclusive no
          primeiro — lá ele é a saída da tela. Sem cabeçalho de navegação
          (o _layout desliga o header), este botão é a única porta desenhada. */}
      <Button
        label={anterior === null ? 'Sair sem pedir' : `Voltar para ${anterior.titulo.toLowerCase()}`}
        variant="ghost"
        disabled={criar.isPending}
        onPress={() => {
          setErros({})
          if (anterior === null) sair()
          else setPasso(anterior.passo)
        }}
      />
    </Screen>
  )
}

/**
 * O que aparece depois que o servidor aceitou o pedido.
 *
 * Tela separada porque o assunto mudou: o pedido existe, tem id, e agora a
 * espera é por um passeador. O resumo aparece de novo — é a última chance de a
 * pessoa reparar num engano de horário enquanto cancelar ainda não custa nada.
 */
function Confirmacao({
  nomeDoAnimal,
  servico,
  quando,
  endereco,
  aoAcompanhar,
  aoVerLista,
}: {
  nomeDoAnimal: string
  servico: string
  quando: Date | null
  endereco: string
  aoAcompanhar: () => void
  aoVerLista: () => void
}): React.JSX.Element {
  const s = useStyles()

  return (
    <Screen scroll>
      <Title>Pedido feito</Title>

      <Body>
        O seu pedido já está à vista dos passeadores da região. Quando alguém aceitar, o horário
        fica guardado por 10 minutos para o pagamento.
      </Body>

      <View style={s.resumo}>
        <LinhaDoResumo rotulo="Animal" valor={nomeDoAnimal} />
        <LinhaDoResumo rotulo="Serviço" valor={servico} />
        <LinhaDoResumo
          rotulo="Dia e hora"
          valor={quando === null ? 'Veja no pedido' : dataPorExtenso(quando)}
        />
        <LinhaDoResumo rotulo="Endereço" valor={endereco} />
      </View>

      <Body dim>
        Enquanto ninguém aceitar, dá para cancelar sem custo nenhum — é dentro do pedido.
      </Body>

      <Button label="Acompanhar este pedido" onPress={aoAcompanhar} />
      <Button label="Ver todos os meus pedidos" variant="ghost" onPress={aoVerLista} />
    </Screen>
  )
}

/**
 * Uma linha da lista de animais.
 *
 * O animal com a antirrábica vencida continua aparecendo, e isso é escolha: se
 * ele sumisse, a pessoa procuraria o cadastro achando que apagou o bicho. Ele
 * aparece impedido, com o motivo escrito e o caminho para resolver ao lado — e
 * o caminho é o cadastro dele, onde está o campo da data.
 */
function LinhaDoAnimal({
  animal,
  escolhido,
  aoEscolher,
  aoAbrirCadastro,
}: {
  animal: Pet
  escolhido: boolean
  aoEscolher: () => void
  aoAbrirCadastro: () => void
}): React.JSX.Element {
  const s = useStyles()

  const servico = servicoDoAnimal(animal.species)
  const especie = animal.species === 'cat' ? 'Gato' : 'Cachorro'
  const detalhe = `${especie} — o serviço dele é ${servicoComArtigo(servico)}`
  const impedido = vacinaEstaVencida(animal.rabies_valid_until)

  if (impedido) {
    return (
      <View style={[s.linha, s.linhaImpedida]}>
        <View style={s.linhaTexto}>
          <Text style={s.linhaTitulo}>{animal.name}</Text>
          <Text style={s.linhaDetalhe}>{detalhe}</Text>
          <Text style={s.linhaImpedimento}>
            A vacina antirrábica está vencida, ou a data ainda não foi informada. Sem ela não dá
            para pedir passeio nem visita.
          </Text>
          <Button
            label={`Abrir o cadastro de ${animal.name}`}
            variant="ghost"
            onPress={aoAbrirCadastro}
          />
        </View>
      </View>
    )
  }

  return (
    <Escolha
      titulo={animal.name}
      detalhe={detalhe}
      escolhida={escolhido}
      aoTocar={aoEscolher}
    />
  )
}

/** Linha de escolha única. O alvo do toque é a linha inteira, não a bolinha. */
function Escolha({
  titulo,
  detalhe,
  escolhida,
  aoTocar,
}: {
  titulo: string
  detalhe?: string
  escolhida: boolean
  aoTocar: () => void
}): React.JSX.Element {
  const s = useStyles()

  return (
    <Pressable
      onPress={aoTocar}
      accessibilityRole="radio"
      accessibilityState={{ checked: escolhida }}
      accessibilityLabel={detalhe === undefined ? titulo : `${titulo}. ${detalhe}`}
      style={({ pressed }) => [
        s.linha,
        escolhida && s.linhaEscolhida,
        pressed && s.linhaPressionada,
      ]}
    >
      {/* A marca é um desenho, não só uma cor: quem não distingue verde de
          cinza continua vendo qual está escolhido. */}
      <View style={[s.marca, escolhida && s.marcaEscolhida]}>
        {escolhida ? <View style={s.marcaMiolo} /> : null}
      </View>

      <View style={s.linhaTexto}>
        <Text style={s.linhaTitulo}>{titulo}</Text>
        {detalhe !== undefined ? <Text style={s.linhaDetalhe}>{detalhe}</Text> : null}
      </View>
    </Pressable>
  )
}

/**
 * A caixa de aceite dos Termos.
 *
 * Quadrada, e não redonda como a escolha única, porque não é a mesma pergunta:
 * radio é "qual destes", caixa é "sim ou não". E o estado marcado tem desenho
 * próprio além da cor — no sol da rua, cor sozinha não se distingue.
 */
function Caixa({
  marcada,
  aoTocar,
  titulo,
  detalhe,
}: {
  marcada: boolean
  aoTocar: () => void
  titulo: string
  detalhe?: string
}): React.JSX.Element {
  const s = useStyles()

  return (
    <Pressable
      onPress={aoTocar}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: marcada }}
      accessibilityLabel={detalhe === undefined ? titulo : `${titulo}. ${detalhe}`}
      style={({ pressed }) => [
        s.linha,
        marcada && s.linhaEscolhida,
        pressed && s.linhaPressionada,
      ]}
    >
      <View style={[s.caixa, marcada && s.caixaMarcada]}>
        {marcada ? <Text style={s.caixaSinal}>✓</Text> : null}
      </View>

      <View style={s.linhaTexto}>
        <Text style={s.linhaTitulo}>{titulo}</Text>
        {detalhe !== undefined ? <Text style={s.linhaDetalhe}>{detalhe}</Text> : null}
      </View>
    </Pressable>
  )
}

/** Uma linha do resumo, com o caminho de volta para o passo que a preencheu. */
function LinhaDoResumo({
  rotulo,
  valor,
  detalhe,
  aoTrocar,
  rotuloDoToque,
}: {
  rotulo: string
  valor: string
  detalhe?: string
  aoTrocar?: () => void
  rotuloDoToque?: string
}): React.JSX.Element {
  const s = useStyles()

  return (
    <View style={s.resumoLinha}>
      <Text style={s.resumoRotulo}>{rotulo}</Text>
      <Text style={s.resumoValor}>{valor}</Text>
      {detalhe !== undefined ? <Text style={s.resumoDetalhe}>{detalhe}</Text> : null}
      {aoTrocar !== undefined ? (
        <Button label={rotuloDoToque ?? 'Trocar'} variant="ghost" onPress={aoTrocar} />
      ) : null}
    </View>
  )
}

/** Linha que abre um seletor do sistema. Mostra o que já está escolhido. */
function Toque({
  rotulo,
  valor,
  escolhido,
  aoTocar,
}: {
  rotulo: string
  valor: string
  escolhido: boolean
  aoTocar: () => void
}): React.JSX.Element {
  const s = useStyles()

  return (
    <Pressable
      onPress={aoTocar}
      accessibilityRole="button"
      accessibilityLabel={`${rotulo}: ${valor}`}
      accessibilityHint="Toque para escolher."
      style={({ pressed }) => [
        s.linha,
        escolhido && s.linhaEscolhida,
        pressed && s.linhaPressionada,
      ]}
    >
      <View style={s.linhaTexto}>
        <Text style={s.linhaDetalhe}>{rotulo}</Text>
        <Text style={s.linhaTitulo}>{valor}</Text>
      </View>
    </Pressable>
  )
}

/** Bloco de atenção. Não é erro: é uma coisa que a pessoa precisa saber. */
function Aviso({ titulo, texto }: { titulo?: string; texto: string }): React.JSX.Element {
  const s = useStyles()

  return (
    <View style={s.aviso} accessibilityLiveRegion="polite">
      {titulo !== undefined ? <Text style={s.avisoTitulo}>{titulo}</Text> : null}
      <Text style={s.avisoTexto}>{texto}</Text>
    </View>
  )
}

// =============================================================================
// Regras da tela
// =============================================================================

/**
 * Qual duração está valendo.
 *
 * A escolha à mão só vale se a duração ainda tiver preço vigente — trocar de
 * animal pode trocar o serviço, e o serviço novo pode não ter a mesma linha em
 * `pricing`. Com uma opção só, ela vem escolhida: lista de um item não é
 * escolha, e exigir o toque faria a pessoa parar para decidir nada.
 */
function duracaoEscolhida(manual: number | null, opcoes: readonly OpcaoDeDuracao[]): number | null {
  if (manual !== null && opcoes.some((o) => o.minutos === manual)) return manual
  return opcoes.length === 1 ? (opcoes[0]?.minutos ?? null) : null
}

/**
 * O que impede o passo atual de terminar.
 *
 * Devolve `null` quando o passo está pronto.
 *
 * `bloqueia` era falso para horário cedo demais e endereço curto, com a ideia de
 * que ali existe algo a consertar na mesma tela. Na prática dava o pior dos dois
 * mundos: o botão ficava ACESO e se recusava a andar, e o toque escrevia o aviso
 * ACIMA dele — o que empurrava o próprio botão para baixo. O segundo toque, no
 * lugar onde o botão estava, caía no texto do aviso. Botão aceso que não anda é
 * exatamente a tela em que a pessoa acha que quebrou o aplicativo.
 *
 * Agora tudo que impede de seguir bloqueia, e o motivo aparece ABAIXO do botão,
 * sem esperar toque nenhum e sem mover nada.
 */
function travasDoPasso(
  passo: Passo,
  dados: {
    animal: Pet | null
    opcaoEscolhida: OpcaoDeDuracao | null
    quando: Date | null
    enderecoLimpo: string
    coordenada: Coordenada | null
  },
): { bloqueia: boolean; motivo: string; erros: Record<string, string> } | null {
  if (passo === 'animal') {
    return dados.animal === null
      ? {
          bloqueia: true,
          motivo: 'Escolha um animal da lista para continuar.',
          erros: { petId: 'Escolha o animal que vai ser atendido.' },
        }
      : null
  }

  if (passo === 'quando') {
    if (dados.opcaoEscolhida === null) {
      return {
        bloqueia: true,
        motivo: 'Enquanto não soubermos o valor do serviço, não dá para seguir.',
        erros: { duracaoMin: 'Escolha quanto tempo o serviço vai durar.' },
      }
    }
    if (dados.quando === null) {
      return {
        bloqueia: true,
        motivo: 'Escolha o dia e a hora para continuar.',
        erros: { quando: 'Escolha o dia e o horário do serviço.' },
      }
    }

    const minutosAteLa = (dados.quando.getTime() - Date.now()) / 60_000
    if (minutosAteLa < FOLGA_MINIMA_MIN) {
      return {
        bloqueia: true,
        motivo:
          'Este horário está perto demais. Marque com pelo menos uma hora de folga: é o tempo de alguém ver o seu pedido, aceitar e chegar até você.',
        erros: {},
      }
    }
    return null
  }

  if (passo === 'onde') {
    if (dados.enderecoLimpo.length < 5) {
      return {
        bloqueia: true,
        motivo: 'Escreva o endereço, com rua e número, para continuar.',
        erros: {},
      }
    }
    if (dados.coordenada === null) {
      // O bloco de aviso do passo já explica o que é o ponto no mapa e por que
      // ele falta; aqui basta ligar o botão apagado àquela explicação.
      return {
        bloqueia: true,
        motivo: 'Falta o ponto no mapa, logo acima, para continuar.',
        erros: {},
      }
    }
    return null
  }

  return null
}

/**
 * O texto novo ainda descreve o mesmo lugar do texto antigo?
 *
 * Serve a uma pergunta só: dá para manter a coordenada marcada pelo aparelho
 * enquanto a pessoa mexe no endereço escrito? Acrescentar "apartamento 2" ao
 * que já estava lá não muda a casa; apagar tudo e escrever outro endereço muda.
 *
 * A conta é grosseira de propósito — comparar o começo dos dois textos. Errar
 * para o lado de descartar a coordenada custa um toque a mais no botão do
 * aparelho; errar para o outro lado manda alguém para a casa errada.
 */
function aindaDescreveOMesmoLugar(antigo: string, novo: string): boolean {
  const a = antigo.trim().toLowerCase()
  const b = novo.trim().toLowerCase()

  // Campo que estava vazio: não havia lugar descrito para contradizer.
  if (a === '') return true

  const menor = a.length <= b.length ? a : b
  const maior = a.length <= b.length ? b : a
  return maior.startsWith(menor)
}

/** O que ainda falta para o pedido poder sair, em frases inteiras. */
function oQueFalta(dados: {
  animal: Pet | null
  quando: Date | null
  opcaoEscolhida: OpcaoDeDuracao | null
  enderecoLimpo: string
  coordenada: Coordenada | null
  temTermos: boolean
  termosCarregando: boolean
  aceitouTermos: boolean
}): string[] {
  const falta: string[] = []

  if (dados.animal === null) falta.push('Escolher o animal que vai ser atendido.')
  if (dados.opcaoEscolhida === null) {
    falta.push('Saber o valor do serviço — sem ele não dá para pedir.')
  }
  if (dados.quando === null) falta.push('Escolher o dia e a hora.')
  if (dados.enderecoLimpo.length < 5) falta.push('Escrever o endereço, com rua e número.')
  if (dados.coordenada === null) falta.push('Dizer onde fica este endereço no mapa.')

  // Esperando e falhando são coisas diferentes, e a frase muda: mandar "tente de
  // novo" para quem está no primeiro segundo da tela faria a pessoa tocar num
  // botão de repetição antes de a primeira tentativa terminar.
  if (dados.termosCarregando) falta.push('Esperar os Termos de Uso terminarem de carregar.')
  else if (!dados.temTermos) falta.push('Carregar os Termos de Uso — tente de novo daqui a pouco.')
  else if (!dados.aceitouTermos) falta.push('Marcar que você leu e aceita os Termos de Uso.')

  return falta
}

/**
 * A dica que a RPC mandou junto com a recusa, quando houver.
 *
 * `hint` não existe em `Error`, e o erro chega tipado como `Error` pela mutação.
 * O `in` pergunta ao objeto de verdade, sem afirmar um tipo que talvez não seja
 * o dele.
 */
function dicaDoErro(erro: Error | null): string | null {
  if (erro === null) return null
  if (!('hint' in erro)) return null
  return typeof erro.hint === 'string' ? erro.hint : null
}

function mensagemDoErro(erro: unknown): string {
  return erro instanceof Error && erro.message !== ''
    ? erro.message
    : 'Não foi possível descobrir onde você está. Tente de novo.'
}

function explicacaoDaOrigem(origem: Origem | null): string {
  if (origem === 'anterior') return 'É o mesmo lugar do seu último pedido.'
  if (origem === 'aparelho') return 'É o lugar onde o seu celular está agora.'
  if (origem === 'digitado') return 'Achamos no mapa pelo endereço que você escreveu.'
  return 'Ainda não sabemos onde fica.'
}

/** "o passeio" / "a visita em casa" — o artigo muda com o gênero da palavra. */
function servicoComArtigo(service: 'walk' | 'visit'): string {
  return `${service === 'walk' ? 'o' : 'a'} ${nomeDoServico(service)}`
}

/** "Passeio de 1 hora", "Visita em casa de 30 minutos". */
function servicoPorExtenso(service: 'walk' | 'visit', minutos: number | null): string {
  const nome = nomeDoServico(service)
  const comMaiuscula = `${nome.charAt(0).toUpperCase()}${nome.slice(1)}`

  const duracao = minutos === null ? null : duracaoPorExtenso(minutos)
  return duracao === null ? comMaiuscula : `${comMaiuscula} de ${duracao}`
}

/**
 * 30 vira "30 minutos", 60 vira "1 hora", 90 vira "1 hora e 30 minutos".
 *
 * Nenhuma duração está escrita aqui: a função converte o número que vier de
 * `pricing`. Devolve null para o que não é duração de verdade.
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

// =============================================================================
// Data e hora — tudo em componentes LOCAIS, do começo ao fim
// =============================================================================

const DIAS_DA_SEMANA = [
  'domingo',
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
] as const

const MESES = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
] as const

/**
 * O horário que a tela sugere quando a pessoa ainda não escolheu nada.
 *
 * Já nasce dentro da folga e na meia hora cheia seguinte, porque no Android
 * basta tocar em OK sem girar nada para confirmar este valor — e o que for
 * confirmado sem pensar precisa ser um horário válido.
 */
function proximoHorarioPossivel(): Date {
  const d = new Date(Date.now() + FOLGA_MINIMA_MIN * 60_000)
  d.setSeconds(0, 0)

  const resto = d.getMinutes() % 30
  // `setMinutes` passa a hora e o dia sozinho quando a conta estoura os 60.
  if (resto !== 0) d.setMinutes(d.getMinutes() + (30 - resto))

  return d
}

/** A meia-noite do primeiro dia em que ainda cabe um horário com folga. */
function primeiroDiaPossivel(): Date {
  const limite = new Date(Date.now() + FOLGA_MINIMA_MIN * 60_000)
  return new Date(limite.getFullYear(), limite.getMonth(), limite.getDate())
}

/**
 * Troca o DIA mantendo a hora, montando um Date novo pelos componentes locais.
 *
 * É aqui que o fuso se resolve: nada de somar milissegundos nem mexer em UTC. O
 * construtor com ano, mês, dia, hora e minuto lê tudo no fuso do aparelho — o
 * mesmo em que a pessoa está lendo a tela.
 */
function comDia(base: Date, dia: Date): Date {
  return new Date(
    dia.getFullYear(),
    dia.getMonth(),
    dia.getDate(),
    base.getHours(),
    base.getMinutes(),
    0,
    0,
  )
}

/** Troca a HORA mantendo o dia, pela mesma razão de `comDia`. */
function comHora(base: Date, hora: Date): Date {
  return new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    hora.getHours(),
    hora.getMinutes(),
    0,
    0,
  )
}

/**
 * "Amanhã, quinta-feira, 18 de setembro de 2026, às 15h30".
 *
 * Comprido de propósito, e com o ano: é a frase que a pessoa lê para conferir,
 * e "18/09 15:30" é fácil demais de ler por cima. Sem `toLocaleString` pelo
 * mesmo motivo de `reais` não usar `Intl`: o Hermes entrega o ICU em versões
 * diferentes conforme o aparelho, e a mesma data sairia escrita de dois jeitos
 * em dois celulares.
 */
function dataPorExtenso(data: Date): string {
  const diferenca = diasDeCalendario(data, new Date())
  const prefixo = diferenca === 0 ? 'Hoje, ' : diferenca === 1 ? 'Amanhã, ' : ''

  const diaDaSemana = DIAS_DA_SEMANA[data.getDay()] ?? ''
  const mes = MESES[data.getMonth()] ?? ''

  return `${prefixo}${diaDaSemana}, ${data.getDate()} de ${mes} de ${data.getFullYear()}, às ${horaCurta(data)}`
}

/** "18/09/2026" — o que cabe no botão que abre o calendário. */
function diaCurto(data: Date): string {
  const dia = `${data.getDate()}`.padStart(2, '0')
  const mes = `${data.getMonth() + 1}`.padStart(2, '0')
  return `${dia}/${mes}/${data.getFullYear()}`
}

/** 15h30, e 8h quando não há minutos. Relógio de 24 horas, como se fala aqui. */
function horaCurta(data: Date): string {
  const hora = data.getHours()
  const minuto = data.getMinutes()
  return minuto === 0 ? `${hora}h` : `${hora}h${`${minuto}`.padStart(2, '0')}`
}

/**
 * Quantos dias de calendário separam os dois — não quantas vezes 24 horas.
 *
 * Um passeio às 8h de amanhã está a 15 horas de distância às 17h de hoje, e
 * "amanhã" continua sendo a resposta certa.
 */
function diasDeCalendario(alvo: Date, agora: Date): number {
  const meiaNoiteDoAlvo = new Date(alvo.getFullYear(), alvo.getMonth(), alvo.getDate()).getTime()
  const meiaNoiteDeHoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).getTime()

  return Math.round((meiaNoiteDoAlvo - meiaNoiteDeHoje) / 86_400_000)
}

/**
 * A primeira mensagem de cada campo é a que fica. O esquema pode reprovar o
 * mesmo campo duas vezes, e a segunda só confundiria quem está lendo.
 */
function errosPorCampo(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): Record<string, string> {
  const mapa: Record<string, string> = {}

  for (const issue of issues) {
    const campo = issue.path[0]
    if (typeof campo !== 'string') continue
    mapa[campo] ??= issue.message
  }

  return mapa
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
    passoRotulo: {
      color: c.textDim,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
      fontWeight: font.weight.bold,
    },

    grupoTitulo: {
      color: c.text,
      fontSize: font.size.md,
      lineHeight: font.line.md,
      fontWeight: font.weight.bold,
      marginTop: spacing.sm,
    },
    grupoAjuda: {
      color: c.textDim,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
    },

    grupo: { gap: spacing.sm },

    linha: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      // A linha inteira é o alvo do toque; 60pt passa folgado dos 44 mínimos.
      minHeight: 60,
      backgroundColor: c.surface,
      borderWidth: 2,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    linhaEscolhida: { borderColor: c.primary, backgroundColor: c.primarySoft },
    linhaPressionada: { borderColor: c.focus },
    // Impedido muda de fundo e ganha a borda de atenção: não é a linha
    // "desligada", é a linha que tem uma pendência escrita dentro dela.
    linhaImpedida: { backgroundColor: c.surfaceAlt, borderColor: c.accent },
    linhaTexto: { flex: 1, gap: 2 },
    linhaTitulo: {
      color: c.text,
      fontSize: font.size.md,
      lineHeight: font.line.md,
      fontWeight: font.weight.medium,
    },
    linhaDetalhe: {
      color: c.textDim,
      fontSize: font.size.xs,
      lineHeight: font.line.xs,
    },
    linhaImpedimento: {
      color: c.accent,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
      fontWeight: font.weight.medium,
      marginTop: spacing.xs,
    },

    marca: {
      width: 24,
      height: 24,
      borderRadius: radius.pill,
      borderWidth: 2,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    marcaEscolhida: { borderColor: c.primary },
    marcaMiolo: {
      width: 12,
      height: 12,
      borderRadius: radius.pill,
      backgroundColor: c.primary,
    },

    caixa: {
      width: 26,
      height: 26,
      borderRadius: radius.sm,
      borderWidth: 2,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    caixaMarcada: { borderColor: c.primary, backgroundColor: c.primary },
    caixaSinal: {
      color: c.textOnPrimary,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
      fontWeight: font.weight.bold,
    },

    // O bloco de conferência: o que a pessoa escolheu, devolvido para ela ler.
    confere: {
      backgroundColor: c.primarySoft,
      borderRadius: radius.md,
      padding: spacing.md,
      gap: spacing.xs,
    },
    confereRotulo: {
      color: c.textDim,
      fontSize: font.size.xs,
      lineHeight: font.line.xs,
      fontWeight: font.weight.medium,
    },
    confereValor: {
      color: c.text,
      fontSize: font.size.md,
      lineHeight: font.line.md,
      fontWeight: font.weight.bold,
    },
    confereNota: {
      color: c.textDim,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
    },

    resumo: { gap: spacing.md },
    resumoLinha: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.divider,
      borderRadius: radius.md,
      padding: spacing.md,
      gap: spacing.xs,
    },
    resumoRotulo: {
      color: c.textDim,
      fontSize: font.size.xs,
      lineHeight: font.line.xs,
      fontWeight: font.weight.medium,
    },
    resumoValor: {
      color: c.text,
      fontSize: font.size.md,
      lineHeight: font.line.md,
      fontWeight: font.weight.medium,
    },
    resumoDetalhe: {
      color: c.textDim,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
    },

    valorBloco: {
      backgroundColor: c.surface,
      borderWidth: 2,
      borderColor: c.primary,
      borderRadius: radius.lg,
      padding: spacing.lg,
      gap: spacing.xs,
    },
    valorRotulo: {
      color: c.textDim,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
      fontWeight: font.weight.medium,
    },
    valor: {
      color: c.text,
      fontSize: font.size.xl,
      lineHeight: font.line.xl,
      fontWeight: font.weight.bold,
    },
    valorNota: {
      color: c.textDim,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
    },

    aviso: {
      backgroundColor: c.accentSoft,
      borderLeftWidth: 4,
      borderLeftColor: c.accent,
      borderRadius: radius.sm,
      padding: spacing.md,
      gap: spacing.sm,
    },
    avisoTitulo: {
      color: c.accent,
      fontSize: font.size.md,
      lineHeight: font.line.md,
      fontWeight: font.weight.bold,
    },
    avisoTexto: {
      color: c.accent,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
    },

    erroTexto: {
      color: c.danger,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
      fontWeight: font.weight.medium,
    },
  })
}
