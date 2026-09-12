/**
 * A foto do animal: encolher no aparelho, subir para o bucket privado e
 * assinar a URL de leitura.
 *
 * É o único arquivo do épico que conversa com o Storage, pelo mesmo motivo que
 * client.ts é o único que instancia o Supabase (ADR decisão 10): quem chama
 * isto é o hook, nunca a tela.
 *
 * O bucket 'pet-photos' é privado — ver 0003_storage.sql. Não existe URL fixa
 * para a foto de um animal: toda leitura passa por uma assinatura com prazo.
 */
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'

import { getCurrentUserId } from './auth'
import { AppError, supabase, toAppError } from './client'

const BUCKET = 'pet-photos'

/**
 * Foto de celular de hoje tem 3 a 8 MB e 4000px de largura. O público deste
 * app está no 4G de Foz, às vezes com franquia no fim do mês, e a tela maior
 * onde essa foto aparece é um cartão de lista. 1024px com compressão 0.7 cai
 * para ~150 KB sem diferença visível — 30 vezes menos dado no ar.
 */
const LARGURA_MAX = 1024
const QUALIDADE = 0.7

/**
 * Uma hora de validade na URL assinada. Curto o bastante para o link não
 * circular por aí depois que a pessoa fecha o app, longo o bastante para
 * atravessar uma sessão de uso inteira sem reassinar.
 */
const VALIDADE_DA_URL_S = 60 * 60

type StorageErrorLike = { message?: string; statusCode?: string; status?: number }

/**
 * O Storage responde em inglês e com frase de servidor ("new row violates
 * row-level security policy"). Quem lê é o tutor, e cada caso aqui tem uma
 * saída diferente — por isso a tradução separa em vez de mandar tudo para uma
 * mensagem só.
 */
function toStorageError(error: unknown, padrao: string): AppError {
  const e = (error as StorageErrorLike | null) ?? {}
  const texto = e.message ?? ''

  // Queda de conexão já tem texto próprio no toAppError, e é o erro mais comum
  // no meio de um upload.
  if (texto.includes('Network request failed')) return toAppError(e)

  const codigo = e.statusCode ?? String(e.status ?? '')

  if (codigo === '413' || texto.includes('maximum allowed size')) {
    return new AppError(
      'A foto ficou grande demais para enviar. Escolha outra foto, de preferência tirada na hora.',
    )
  }
  if (codigo === '401' || codigo === '403' || texto.includes('row-level security')) {
    return new AppError(
      'Você não tem permissão para guardar a foto deste animal. Saia do aplicativo e entre de novo.',
    )
  }

  return toAppError({ message: padrao })
}

async function requireUserId(): Promise<string> {
  const userId = await getCurrentUserId()
  if (userId === null) {
    throw new AppError('Sua sessão expirou. Entre de novo para continuar.')
  }
  return userId
}

/**
 * Devolve o caminho de um JPEG já reduzido, no cache do aparelho.
 */
async function reduzirParaEnvio(localUri: string): Promise<string> {
  try {
    const original = await ImageManipulator.manipulate(localUri).renderAsync()

    // `resize` não entende "no máximo": pedir 1024 numa foto de 600px de
    // largura a estica, gastando bytes para deixar a imagem pior. Por isso a
    // largura original é medida antes.
    const ajustada =
      original.width > LARGURA_MAX
        ? await ImageManipulator.manipulate(original)
            .resize({ width: LARGURA_MAX })
            .renderAsync()
        : original

    const resultado = await ajustada.saveAsync({
      compress: QUALIDADE,
      format: SaveFormat.JPEG,
    })
    return resultado.uri
  } catch {
    // Arquivo corrompido, HEIC que o aparelho não decodifica, cache cheio. A
    // pessoa não tem como agir sobre nenhum deles a não ser escolher outra.
    throw new AppError(
      'Não foi possível preparar esta foto para envio. Escolha outra foto ou tire uma nova.',
    )
  }
}

/**
 * Lê o arquivo local como bytes crus.
 *
 * Por que ArrayBuffer e não Blob, File ou FormData: no React Native o Blob é
 * uma casca — guarda uma referência nativa, não os bytes — e o supabase-js, ao
 * montar o corpo da requisição a partir dele, envia um objeto de tamanho zero.
 * A documentação do próprio @supabase/storage-js diz isso em letra miúda
 * ("For React Native, using either Blob, File or FormData does not work as
 * intended"). FormData com `{ uri, name, type }` até sobe, mas aí quem monta o
 * multipart é o RN, e o cacheControl que o storage-js acrescenta ao corpo fica
 * fora de ordem em parte dos aparelhos Android. ArrayBuffer é o caminho que
 * funciona igual nos dois sistemas, e é o que a documentação do Supabase para
 * Expo usa.
 */
async function lerComoArrayBuffer(uri: string): Promise<ArrayBuffer> {
  let bytes: ArrayBuffer
  try {
    const resposta = await fetch(uri)
    bytes = await resposta.arrayBuffer()
  } catch {
    throw new AppError(
      'Não foi possível ler a foto escolhida. Escolha a foto de novo.',
    )
  }

  // Arquivo de zero byte sobe sem erro nenhum e vira um quadrado quebrado na
  // tela do tutor, que não tem como saber que deu errado. Melhor falhar aqui.
  if (bytes.byteLength === 0) {
    throw new AppError(
      'A foto escolhida está vazia. Escolha outra foto ou tire uma nova.',
    )
  }
  return bytes
}

/**
 * Sobe a foto e devolve o caminho dentro do bucket — é esse caminho que vai
 * para `pets.photo_path`.
 *
 * Note que esta função NÃO grava nada na tabela: ela só põe o arquivo no
 * lugar. Quem liga o arquivo ao animal é `setPetPhoto`, e essa separação é de
 * propósito — animal salvo sem foto é um cadastro incompleto, animal com
 * photo_path apontando para arquivo que não subiu é um cadastro quebrado.
 *
 * @param localUri caminho que o expo-image-picker devolveu.
 */
export async function uploadPetPhoto(petId: string, localUri: string): Promise<string> {
  const ownerId = await requireUserId()

  const reduzida = await reduzirParaEnvio(localUri)
  const bytes = await lerComoArrayBuffer(reduzida)

  // '<dono>/<animal>.jpg' é o mesmo caminho para sempre, e o upsert grava por
  // cima. Nome novo a cada envio deixaria a foto antiga no bucket, ocupando
  // espaço pago e sem ninguém para apagá-la — o app não apaga arquivo. A pasta
  // com o id do dono é o que a policy do 0003_storage.sql confere.
  const path = `${ownerId}/${petId}.jpg`

  const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, {
    contentType: 'image/jpeg',
    upsert: true,
  })

  if (error) {
    throw toStorageError(
      error,
      'Não foi possível enviar a foto agora. O animal continua cadastrado — tente enviar a foto de novo mais tarde.',
    )
  }

  return path
}

/**
 * A URL para mostrar a foto na tela.
 *
 * O contrato do épico pedia `petPhotoUrl(path): string | null`, síncrona. Não
 * dá: o bucket é privado, e uma URL de bucket privado só existe depois que o
 * servidor a assina. O nome mudou junto com o tipo de propósito — `petPhotoUrl`
 * usada como síncrona não estoura, ela devolve uma Promise que vira
 * "[object Promise]" dentro do `uri` da Image e some sem erro nenhum. Com
 * "sign" no nome, quem escrever a tela do passeador no épico 3 vê o await que
 * falta antes de escrever a linha.
 *
 * Quem chama de dentro de uma tela usa `usePetPhoto` (src/hooks/usePets), nunca
 * isto direto.
 *
 * Devolve null — em vez de estourar — quando a assinatura falha: a foto é o
 * enfeite do cadastro, e uma queda de rede não pode derrubar a tela que mostra
 * a vacina e as observações de risco do animal.
 */
export async function signPetPhotoUrl(path: string | null): Promise<string | null> {
  if (path === null || path === '') return null

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, VALIDADE_DA_URL_S)

  if (error || data === null) return null
  return data.signedUrl
}
