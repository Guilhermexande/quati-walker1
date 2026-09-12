/**
 * De onde sai a coordenada do endereço do serviço.
 *
 * O banco exige `address_geog` (0001_schema.sql): pedido sem latitude e
 * longitude não entra. E não existe — nem vai existir — serviço pago de
 * geocodificação neste projeto. Sobram três caminhos, nesta ordem de confiança:
 *
 *   1. o endereço de um pedido anterior da própria pessoa (fica em
 *      `requests.ultimoEndereco`, não aqui: aquilo é leitura de banco);
 *   2. `minhaLocalizacao()`, com a pessoa confirmando na tela que está no
 *      endereço do serviço AGORA;
 *   3. `coordenadaDoEndereco()`, que é conveniência e falha calada — no Android
 *      sem chave do Google ela volta vazia com frequência, e isso é o normal,
 *      não é defeito. NUNCA pode ser o único caminho de uma tela.
 *
 * Sem coordenada, o botão de confirmar não fica disponível. Uma coordenada
 * errada é pior do que nenhuma: ninguém percebe o engano até o passeador tocar
 * a campainha na casa errada.
 */
import * as Location from 'expo-location'

import { AppError } from '@/lib/erros'

export type Coordenada = { lat: number; lng: number }

/**
 * Quanto tempo esperar pelo aparelho achar o sinal.
 *
 * Dentro de casa, com o aparelho encostado numa parede, o GPS demora. Quinze
 * segundos é o limite do que alguém encara olhando para uma tela parada; daí em
 * diante ela acha que travou e sai do aplicativo.
 */
const ESPERA_MAX_MS = 15_000

/**
 * Quando a busca demora demais, vale a última posição que o aparelho já tinha —
 * mas só se for de agora há pouco e com boa precisão. Uma posição de meia hora
 * atrás seria o trabalho da pessoa, não a casa dela, e entraria no pedido sem
 * ninguém desconfiar.
 */
const IDADE_MAX_DA_ULTIMA_MS = 2 * 60 * 1000
const PRECISAO_MIN_DA_ULTIMA_M = 200

/**
 * Retângulo em volta de Foz do Iguaçu, com folga para a região (Santa Terezinha,
 * São Miguel, Medianeira). Vale SÓ para o palpite do geocodificador — ver
 * `coordenadaDoEndereco`. Não é regra de área de atendimento: o ADR não define
 * nenhuma, e `minhaLocalizacao()` devolve onde a pessoa está, seja onde for.
 */
const REGIAO = { latMin: -26.2, latMax: -24.9, lngMin: -55.2, lngMax: -53.9 }

/** Endereço curto demais o geocodificador "acha" no centro de qualquer cidade. */
const TAMANHO_MINIMO_DO_ENDERECO = 8

const GPS_DESLIGADO =
  'O GPS do aparelho está desligado. Ligue a localização nas configurações do aparelho e toque de novo.'

const PRECISA_AUTORIZAR =
  'Para marcar o endereço pelo lugar onde você está, o aplicativo precisa da sua autorização. Toque de novo e escolha Permitir.'

const BLOQUEADO_NAS_CONFIGURACOES =
  'O acesso à sua localização está bloqueado para o Quati Walker. Abra as configurações do aparelho, procure o Quati Walker e libere a localização — ou escolha o endereço de um pedido anterior.'

const NAO_ACHOU =
  'O aparelho não conseguiu achar onde você está. Chegue perto de uma janela ou saia até a rua e toque de novo. Se não der certo, use o endereço de um pedido anterior.'

/**
 * Só aceita um par de números que possa ser um lugar na Terra.
 *
 * Emulador e aparelho sem sinal às vezes respondem 0, 0 — que é um ponto no mar,
 * na costa da África, e o banco aceita sem reclamar porque é um ponto válido.
 */
function paraCoordenada(lat: number, lng: number): Coordenada | null {
  const valido =
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)

  return valido ? { lat, lng } : null
}

/**
 * O erro das bibliotecas nativas chega em inglês e com código de programador
 * ('E_LOCATION_SERVICES_DISABLED'). Quem lê é a tutora, no meio do pedido.
 */
function erroDeLocalizacao(erro: unknown): AppError {
  const e = (erro as { code?: string; message?: string } | null) ?? {}
  const texto = `${e.code ?? ''} ${e.message ?? ''}`

  if (texto.includes('SERVICES_DISABLED') || texto.includes('SETTINGS_UNSATISFIED')) {
    return new AppError(GPS_DESLIGADO)
  }
  if (texto.includes('NO_PERMISSIONS') || texto.includes('UNAUTHORIZED')) {
    return new AppError(PRECISA_AUTORIZAR)
  }
  return new AppError(NAO_ACHOU)
}

/**
 * Pede a autorização e trata as três respostas possíveis.
 *
 * `requestForegroundPermissionsAsync` volta na hora, sem perguntar nada, quando
 * já foi autorizada antes ou quando a pessoa marcou "não perguntar de novo" —
 * é `canAskAgain` que separa os dois casos negados, e eles têm saídas
 * diferentes: um se resolve com outro toque, o outro só nas configurações.
 */
async function exigirAutorizacao(): Promise<void> {
  let resposta: Location.LocationPermissionResponse
  try {
    resposta = await Location.requestForegroundPermissionsAsync()
  } catch {
    throw new AppError(
      'Não foi possível pedir acesso à localização neste aparelho. Use o endereço de um pedido anterior.',
    )
  }

  if (resposta.status === Location.PermissionStatus.GRANTED) return
  throw new AppError(resposta.canAskAgain ? PRECISA_AUTORIZAR : BLOQUEADO_NAS_CONFIGURACOES)
}

/**
 * Autorizar o aplicativo e ter o GPS ligado são coisas diferentes, e a pessoa
 * precisa saber qual das duas falta. Conferir antes de procurar a posição é o
 * que troca uma espera de quinze segundos terminando em "não achei" por uma
 * frase que diz o que fazer.
 */
async function exigirGpsLigado(): Promise<void> {
  let ligado: boolean
  try {
    ligado = await Location.hasServicesEnabledAsync()
  } catch {
    // Não dá para saber: segue em frente e deixa a busca falhar com a mensagem
    // dela. Travar o pedido por causa desta conferência seria pior.
    return
  }
  if (!ligado) throw new AppError(GPS_DESLIGADO)
}

/**
 * Devolve null quando estourou o tempo — quem chama decide o que fazer com isso.
 *
 * Precisão `Balanced` (~100 m) e não `High` (~10 m) de propósito: o que a
 * coordenada faz é achar passeadores por perto, e o raio deles se conta em
 * quilômetros. Cem metros não muda quem aparece, e `High` custa muito mais
 * tempo dentro de casa, que é justo onde a pessoa vai estar ao pedir.
 */
async function posicaoAgora(): Promise<Coordenada | null> {
  let temporizador: ReturnType<typeof setTimeout> | undefined

  try {
    const posicao = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((resolver) => {
        temporizador = setTimeout(() => resolver(null), ESPERA_MAX_MS)
      }),
    ])

    if (posicao === null) return null
    return paraCoordenada(posicao.coords.latitude, posicao.coords.longitude)
  } catch (erro) {
    throw erroDeLocalizacao(erro)
  } finally {
    // A busca continua rodando lá dentro mesmo depois do tempo esgotado; o que
    // não pode é o contador ficar de pé segurando o aparelho acordado.
    if (temporizador !== undefined) clearTimeout(temporizador)
  }
}

async function ultimaPosicaoRecente(): Promise<Coordenada | null> {
  try {
    const ultima = await Location.getLastKnownPositionAsync({
      maxAge: IDADE_MAX_DA_ULTIMA_MS,
      requiredAccuracy: PRECISAO_MIN_DA_ULTIMA_M,
    })
    if (ultima === null) return null
    return paraCoordenada(ultima.coords.latitude, ultima.coords.longitude)
  } catch {
    return null
  }
}

/**
 * Onde a pessoa está agora.
 *
 * CHAME ISTO NO TOQUE DO BOTÃO, nunca ao abrir a tela. A autorização de
 * localização é pedida aqui dentro, e uma janela do sistema aparecendo sozinha
 * na abertura é a maneira mais rápida de alguém tocar em "Não permitir" sem
 * entender o que foi perguntado — e aí só as configurações do aparelho
 * resolvem.
 *
 * A tela ainda precisa perguntar, em palavras, se a pessoa está NO ENDEREÇO DO
 * SERVIÇO neste momento. Esta função sabe onde o celular está; só a dona dele
 * sabe se ali é a casa do animal.
 *
 * Erra sempre com AppError: a mensagem já está pronta para aparecer no
 * ErrorBanner, e cada uma diz o próximo passo.
 */
export async function minhaLocalizacao(): Promise<Coordenada> {
  await exigirAutorizacao()
  await exigirGpsLigado()

  const agora = await posicaoAgora()
  if (agora !== null) return agora

  const ultima = await ultimaPosicaoRecente()
  if (ultima !== null) return ultima

  throw new AppError(NAO_ACHOU)
}

/**
 * Tenta adivinhar a coordenada a partir do endereço digitado. Conveniência, e
 * só: devolve null com facilidade e sem barulho.
 *
 * Nunca estoura e nunca pede autorização — quem está digitando um endereço não
 * pediu para o sistema perguntar nada. No Android sem chave do Google, o
 * `geocodeAsync` volta uma lista vazia em silêncio; no iOS costuma responder.
 * Os dois casos terminam igual aqui: sem coordenada, a tela segue pelos outros
 * caminhos.
 *
 * O resultado fora da região é descartado porque o geocodificador responde a
 * palpites: "Rua das Flores", sem cidade, existe em quase todo município do
 * Brasil, e ele devolve a primeira que achar, com a mesma cara de acerto. Um
 * pedido com a coordenada de outro estado não dá erro em lugar nenhum — ele só
 * não encontra passeador, e ninguém entende por quê.
 */
export async function coordenadaDoEndereco(texto: string): Promise<Coordenada | null> {
  const endereco = texto.trim()
  if (endereco.length < TAMANHO_MINIMO_DO_ENDERECO) return null

  let achados: Location.LocationGeocodedLocation[]
  try {
    achados = await Location.geocodeAsync(endereco)
  } catch {
    return null
  }

  const primeiro = achados[0]
  if (primeiro === undefined) return null

  const coordenada = paraCoordenada(primeiro.latitude, primeiro.longitude)
  if (coordenada === null) return null

  const naRegiao =
    coordenada.lat >= REGIAO.latMin &&
    coordenada.lat <= REGIAO.latMax &&
    coordenada.lng >= REGIAO.lngMin &&
    coordenada.lng <= REGIAO.lngMax

  return naRegiao ? coordenada : null
}
