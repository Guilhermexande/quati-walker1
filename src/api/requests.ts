/**
 * Os pedidos de serviço do tutor.
 *
 * Escrever aqui é sempre chamar RPC (ADR decisão 10): `create_service_request`
 * e `cancel_request`, em 0002_rpc.sql. Elas é que derivam preço, comissão e
 * repasse da tabela `pricing`, carimbam a versão dos Termos, tiram o snapshot do
 * animal e calculam o split do cancelamento. Este arquivo não decide nada disso
 * — e não manda um centavo ao servidor.
 *
 * O que ele faz é o outro lado: as RPCs recusam levantando exceção, e a exceção
 * chega à tela como veio do Postgres. "sem preço vigente para walk / 60 min" é
 * uma frase correta e inútil para quem está com a coleira na mão. Traduzi-la é
 * o trabalho deste arquivo, no mesmo espírito do `readable()` de pets.ts.
 */
import type { PostgrestError } from '@supabase/supabase-js'
import { getCurrentUserId } from './auth'
import { AppError, supabase, toAppError } from './client'
import { getPet } from './pets'
import type { Database } from './types.gen'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ServiceRequest = Database['public']['Tables']['service_requests']['Row']

export type RequestInput = {
  petId: string
  service: 'walk' | 'visit'
  duracaoMin: number
  enderecoTexto: string
  lat: number
  lng: number
  /** Horário do serviço em ISO 8601 com fuso — o que `toISOString()` devolve. */
  quando: string
}

export type Coordenada = { lat: number; lng: number }

async function requireUserId(): Promise<string> {
  const userId = await getCurrentUserId()
  if (userId === null) {
    throw new AppError('Sua sessão expirou. Entre de novo para continuar.')
  }
  return userId
}

function contem(error: PostgrestError, trecho: string): boolean {
  return error.message.includes(trecho)
}

/**
 * O nome do animal, só para montar a mensagem de erro.
 *
 * Engole a própria falha de propósito: já estamos no caminho do erro, e deixar
 * uma segunda exceção subir daqui trocaria "a vacina do Bidu está vencida" por
 * um erro de rede — que não tem nada a ver com o que aconteceu.
 */
async function nomeDoAnimal(petId: string): Promise<string | null> {
  try {
    const pet = await getPet(petId)
    return pet?.name ?? null
  } catch {
    return null
  }
}

/**
 * Traduz a recusa de `create_service_request`.
 *
 * As quatro primeiras são as que nunca podem chegar cruas na tela: ou culpam a
 * pessoa por algo que não é culpa dela, ou dizem o problema sem dizer onde se
 * conserta. O resto das mensagens do servidor já está em português de gente e
 * passa direto.
 */
async function erroAoCriar(error: PostgrestError, input: RequestInput): Promise<AppError> {
  // O hint vem de `using hint = 'pagar_antes'` na RPC. A mensagem do servidor
  // termina em "Pague antes de solicitar", que hoje não dá para fazer: o
  // pagamento antecipado é do Épico 5 e ainda não existe tela para ele. Dizer
  // para pagar sem ter onde pagar é pior do que não dizer nada.
  if (error.hint === 'pagar_antes') {
    return new AppError(
      'Três ou mais reservas suas venceram nos últimos 30 dias porque o pagamento não saiu dentro dos 10 minutos. Por causa disso, não dá para marcar um serviço novo por aqui agora.',
      'pagar_antes',
    )
  }

  if (contem(error, 'vacina antirrábica')) {
    const nome = await nomeDoAnimal(input.petId)
    // "de Mel" e "de Bidu" servem para qualquer nome. "do Mel" seria errado, e
    // adivinhar o gênero do nome de um animal é adivinhação mesmo.
    const quem = nome === null ? 'deste animal' : `de ${nome}`
    const cadastro = nome === null ? 'dele' : `de ${nome}`
    return new AppError(
      `A vacina antirrábica ${quem} está vencida, ou a data ainda não foi informada. Abra o cadastro ${cadastro}, coloque a data que está na carteirinha, e volte para marcar o serviço.`,
    )
  }

  if (contem(error, 'ao menos 15 minutos no futuro')) {
    return new AppError(
      // Mesmo motivo do schema: a pessoa leu "uma hora de folga" na tela e é
      // essa a regra que ela tem que conseguir cumprir. Este erro só aparece
      // quando o horário envelhece enquanto ela preenche o resto.
      'Escolha um horário com pelo menos uma hora de folga. É o tempo de alguém ver o seu pedido, aceitar e conseguir chegar até você.',
    )
  }

  // Falta linha na tabela `pricing` para esta combinação de serviço e duração.
  // É falha da plataforma, e a frase precisa deixar isso claro — senão a pessoa
  // fica procurando o que ela preencheu errado, e não há nada errado.
  if (contem(error, 'sem preço vigente')) {
    return new AppError(
      'Não conseguimos ver o valor deste serviço agora. O problema é nosso, não do seu cadastro. Tente de novo daqui a pouco.',
    )
  }

  if (contem(error, 'o animal não pertence a este cliente')) {
    return new AppError(
      'Este animal não está na sua conta. Volte para a lista e escolha um dos seus.',
    )
  }

  if (contem(error, 'animal arquivado')) {
    return new AppError(
      'Você removeu este animal da sua lista. Para marcar um serviço com ele, cadastre-o de novo.',
    )
  }

  if (contem(error, 'não autenticado')) {
    return new AppError('Sua sessão expirou. Entre de novo para continuar.')
  }

  // 22007 / 22008: o Postgres não entendeu o timestamp. Só acontece se o horário
  // chegar deformado da tela, e a resposta dele é em inglês.
  if (error.code === '22007' || error.code === '22008') {
    return new AppError('Não entendemos a data e a hora escolhidas. Escolha o dia e o horário de novo.')
  }

  // 23502: `address_geog` é NOT NULL e o ponto sai de st_makepoint(lng, lat).
  // Coordenada nula chega aqui como "null value in column". `conferirEndereco`
  // barra isso antes, mas se escapar a pessoa lê endereço, não nome de coluna.
  if (error.code === '23502') {
    return new AppError(
      'Ainda não sabemos onde fica este endereço. Escolha o endereço de novo antes de confirmar.',
    )
  }

  // 'Gato só aceita visita em casa' e 'Cão só aceita passeio' caem aqui: já são
  // frases que a tutora entende, e `toAppError` as repassa inteiras.
  return toAppError(error)
}

function erroAoCancelar(error: PostgrestError): AppError {
  if (contem(error, 'solicitação inexistente')) {
    return new AppError('Não encontramos este pedido. Volte para a lista e abra de novo.')
  }
  if (contem(error, 'sem permissão')) {
    return new AppError('Este pedido não é da sua conta. Volte para a lista e abra um dos seus.')
  }
  if (contem(error, 'já está encerrado')) {
    return new AppError('Este serviço já foi encerrado. Não há mais nada para cancelar aqui.')
  }
  // 'serviço em andamento não pode ser cancelado; registre um incidente' já
  // chega pronta do servidor e passa por `toAppError`.
  return toAppError(error)
}

/**
 * Confere a coordenada antes de gastar uma ida ao servidor.
 *
 * O banco monta o ponto com `st_makepoint(p_lng, p_lat)` e não tem como
 * desconfiar do que recebe: número fora do mundo vira um ponto que existe, só
 * que no lugar errado — e aí nenhum passeador aparece e ninguém entende por quê.
 *
 * (0, 0) merece linha própria: é o Atlântico na altura da África, e é
 * exatamente o que sobra quando uma leitura de GPS falha e alguém preencheu
 * zero no lugar. Nunca é um endereço em Foz.
 */
function conferirEndereco(lat: number, lng: number): void {
  const noMundo =
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  const nulaIlha = lat === 0 && lng === 0

  if (!noMundo || nulaIlha) {
    throw new AppError(
      'Ainda não sabemos onde fica este endereço. Use o endereço de um pedido anterior, ou confirme que você está no local do serviço agora.',
    )
  }
}

/**
 * Cria o pedido.
 *
 * Repare no que NÃO vai no payload: preço, comissão, repasse, versão dos Termos
 * e o snapshot do animal. Tudo isso é derivado pelo trigger
 * `assert_request_insert`, a partir da tabela `pricing` e da linha do animal. O
 * app manda escolha, nunca valor (ADR decisão 2).
 */
export async function createRequest(input: RequestInput): Promise<string> {
  await requireUserId()
  conferirEndereco(input.lat, input.lng)

  const { data, error } = await supabase.rpc('create_service_request', {
    p_pet_id: input.petId,
    p_service: input.service,
    p_duration_min: input.duracaoMin,
    p_address_text: input.enderecoTexto.trim(),
    p_lat: input.lat,
    p_lng: input.lng,
    // Já vem em ISO com fuso da tela, montado sobre o Date local de quem
    // escolheu. A coluna é timestamptz: o Postgres guarda o instante, não o
    // texto, e devolve o mesmo instante para quem ler de qualquer fuso.
    p_scheduled_at: input.quando,
  })

  if (error) throw await erroAoCriar(error, input)
  return data
}

/**
 * Cancela o pedido.
 *
 * Quanto volta para a pessoa é decidido pelo trigger `assert_status_transition`
 * e gravado em `refund_cents`. O app só mostra a previsão antes
 * (`reembolsoSeCancelarAgora`, em @/schemas/request) e relê a linha depois.
 */
export async function cancelRequest(id: string, motivo?: string): Promise<void> {
  await requireUserId()

  if (!UUID.test(id)) {
    throw new AppError('Não encontramos este pedido. Volte para a lista e abra de novo.')
  }

  // Motivo em branco é ausência de motivo, e a coluna `cancel_reason` aceita
  // nulo. Mandar '' gravaria um motivo vazio que depois aparece como um traço
  // solto na tela de quem ia atender.
  const limpo = motivo?.trim()
  const campoMotivo = limpo === undefined || limpo === '' ? {} : { p_reason: limpo }

  const { error } = await supabase.rpc('cancel_request', {
    p_request_id: id,
    ...campoMotivo,
  })

  if (error) throw erroAoCancelar(error)
}

/**
 * Os pedidos do tutor, do mais recente para o mais antigo.
 *
 * Sem recorte de estado: o cancelado e o vencido continuam na lista porque são
 * o histórico dela, e porque sumir com o pedido é a forma mais rápida de fazer
 * alguém achar que pagou por nada.
 */
export async function listMyRequests(): Promise<ServiceRequest[]> {
  const userId = await getCurrentUserId()
  if (userId === null) return []

  // A policy `sr_sel_client` já limita as linhas ao cliente, mas `sr_sel_walker`
  // e `sr_sel_admin` somam outras — o filtro por client_id é o que garante que
  // "meus pedidos" sejam os que eu pedi, em qualquer papel.
  const { data, error } = await supabase
    .from('service_requests')
    .select()
    .eq('client_id', userId)
    .order('created_at', { ascending: false })

  if (error) throw toAppError(error)
  return data
}

export async function getRequest(id: string): Promise<ServiceRequest | null> {
  // O id vem da rota, e rota se digita errado: link antigo, notificação de
  // outro aparelho, deep link torto. Sem esta conferência o Postgres responde
  // 22P02 e a pessoa lê 'invalid input syntax for type uuid' na tela.
  if (!UUID.test(id)) return null

  const userId = await getCurrentUserId()
  if (userId === null) return null

  const { data, error } = await supabase
    .from('service_requests')
    .select()
    .eq('id', id)
    .eq('client_id', userId)
    .maybeSingle()

  if (error) throw toAppError(error)
  return data
}

/**
 * Lê o ponto que veio na coluna `address_geog`.
 *
 * A coluna é `geography`, e AQUI MORA UMA ARMADILHA CONFERIDA NO BANCO: o
 * PostGIS registra o cast para json apenas do tipo `geometry`. `geography` não
 * tem esse cast, então o `json_agg` que o PostgREST monta cai no formato texto
 * do tipo — o EWKB em hexadecimal:
 *
 *   0101000020E6100000098A1F63EE4A4BC0C0EC9E3C2C8439C0
 *   ^^ ordem   ^^^^^^^^ tipo+SRID  ^^^^^^^^^^^^^^^^ X   ^^^^^^^^^^^^^^^^ Y
 *
 * O primeiro double é X — LONGITUDE. O segundo é Y — latitude. É a ordem
 * contrária à que todo mundo fala, e é a mesma do GeoJSON. Trocar os dois não
 * levanta erro nenhum: põe o passeio no meio do oceano Índico e o pedido
 * simplesmente nunca encontra ninguém.
 *
 * O ramo de GeoJSON fica por garantia: basta alguém criar o cast que falta, ou
 * uma versão do PostgREST passar a serializar geography como objeto, para o
 * formato mudar sem aviso. As duas formas trazem [longitude, latitude].
 */
function coordenadaDaColuna(valor: unknown): Coordenada | null {
  if (typeof valor === 'string') return coordenadaDoHex(valor)
  if (typeof valor === 'object' && valor !== null) return coordenadaDoGeoJson(valor)
  return null
}

function coordenadaDoGeoJson(valor: object): Coordenada | null {
  if (!('coordinates' in valor)) return null

  const coordenadas: unknown = valor.coordinates
  if (!Array.isArray(coordenadas)) return null

  const lista: unknown[] = coordenadas
  const lng = lista[0]
  const lat = lista[1]

  if (typeof lng !== 'number' || typeof lat !== 'number') return null
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  return { lat, lng }
}

/**
 * Desmonta o EWKB de um ponto.
 *
 * Um byte de ordem (01 = little endian), quatro do tipo — com 0x20000000 ligado
 * quando o SRID acompanha —, quatro do SRID, e dois doubles de oito bytes.
 * Qualquer coisa fora disso devolve null: é melhor a tela pedir o endereço de
 * novo do que reaproveitar um ponto que ninguém conferiu.
 */
function coordenadaDoHex(hex: string): Coordenada | null {
  if (hex.length < 42 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null

  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }

  const leitor = new DataView(bytes.buffer)
  const littleEndian = bytes[0] === 1
  const tipo = leitor.getUint32(1, littleEndian)

  // Os 8 bits baixos guardam a geometria; 1 é ponto. Linha e polígono não têm
  // "a" coordenada, e endereço de serviço é sempre ponto.
  if ((tipo & 0xff) !== 1) return null

  const inicio = (tipo & 0x20000000) === 0 ? 5 : 9
  if (bytes.length < inicio + 16) return null

  const lng = leitor.getFloat64(inicio, littleEndian)
  const lat = leitor.getFloat64(inicio + 8, littleEndian)

  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  return { lat, lng }
}

/**
 * O endereço do último pedido da pessoa, com a coordenada.
 *
 * É o primeiro dos dois caminhos para ter lat/lng sem serviço de
 * geocodificação: quem já pediu uma vez não precisa provar de novo onde mora, e
 * o ponto já foi conferido quando o pedido anterior foi feito.
 *
 * Devolve null quando não há pedido anterior, ou quando o ponto veio num
 * formato que não deu para ler — nos dois casos a tela cai no GPS.
 */
export async function ultimoEndereco(): Promise<{ texto: string; lat: number; lng: number } | null> {
  const userId = await getCurrentUserId()
  if (userId === null) return null

  const { data, error } = await supabase
    .from('service_requests')
    .select('address_text, address_geog')
    .eq('client_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw toAppError(error)
  if (data === null) return null

  const ponto = coordenadaDaColuna(data.address_geog)
  if (ponto === null) return null

  return { texto: data.address_text, lat: ponto.lat, lng: ponto.lng }
}
