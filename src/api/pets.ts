/**
 * Os animais do tutor.
 *
 * Como `profiles`, este é um dos casos sem RPC (ADR decisão 10): cadastrar um
 * animal não mexe em dinheiro nem em estado de serviço, e quem protege a linha
 * são as policies `pets_own`, `pets_ins` e `pets_upd` (`owner_id = auth.uid()`).
 * O que o banco cobra de verdade — porte do cão, vacina em dia — é cobrado por
 * constraint e trigger, e repetido antes em `@/schemas/pet` para a pessoa ler a
 * exigência na tela, não no erro.
 */
import type { PostgrestError } from '@supabase/supabase-js'
import { getCurrentUserId } from './auth'
import { AppError, supabase, toAppError } from './client'
import type { Database } from './types.gen'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type Pet = Database['public']['Tables']['pets']['Row']

export type PetInput = {
  name: string
  species: 'dog' | 'cat'
  size: 'small' | 'medium' | 'large' | null
  breed: string | null
  rabiesValidUntil: string | null
  riskNotes: string | null
}

/** As colunas que a tela escreve. O resto da linha é do banco. */
type PetWrite = Pick<
  Database['public']['Tables']['pets']['Insert'],
  'name' | 'species' | 'size' | 'breed' | 'rabies_valid_until' | 'risk_notes'
>

async function requireUserId(): Promise<string> {
  const userId = await getCurrentUserId()
  if (userId === null) {
    throw new AppError('Sua sessão expirou. Entre de novo para continuar.')
  }
  return userId
}

/**
 * `toAppError` repassa a mensagem do servidor porque as RPCs escrevem em
 * português. Constraint, policy e PostgREST não têm esse cuidado: chegam como
 * "violates check constraint" e "JSON object requested, multiple (or no) rows
 * returned". Estes três casos ganham texto próprio.
 */
function readable(error: PostgrestError, deniedMessage: string): AppError {
  if (error.code === '23514' && error.message.includes('dog_requires_size')) {
    return new AppError('Escolha o porte do cão — pequeno, médio ou grande — para continuar.')
  }
  // PGRST116: o filtro não achou linha nenhuma. Para quem tem sessão aberta, é
  // animal que não existe mais ou que nunca foi dele.
  if (error.code === 'PGRST116') {
    return new AppError('Não encontramos esse animal. Volte para a lista e tente de novo.')
  }
  if (error.code === '42501') return new AppError(deniedMessage)
  return toAppError(error)
}

/** Texto em branco é ausência de informação, e o banco já tem um jeito de dizer isso. */
function ouNulo(texto: string | null): string | null {
  const limpo = texto?.trim()
  return limpo === undefined || limpo === '' ? null : limpo
}

function toColumns(input: PetInput): PetWrite {
  return {
    name: input.name.trim(),
    species: input.species,
    // Gato não tem porte: o serviço dele é visita em casa, e o porte não muda
    // nada no atendimento. Gravar o que sobrou do formulário não quebra o banco,
    // mas depois aparece como "gato de porte grande" na tela do passeador.
    size: input.species === 'cat' ? null : input.size,
    breed: ouNulo(input.breed),
    rabies_valid_until: ouNulo(input.rabiesValidUntil),
    risk_notes: ouNulo(input.riskNotes),
  }
}

/**
 * Os animais em cena, do mais novo para o mais antigo.
 *
 * Sem os arquivados: eles continuam na tabela por causa do histórico de
 * serviços, mas para o tutor eles já saíram da vida dele.
 */
export async function listMyPets(): Promise<Pet[]> {
  const userId = await getCurrentUserId()
  if (userId === null) return []

  // A policy já limita as linhas ao dono, mas o admin enxerga todas — o filtro
  // por owner_id é o que garante que "meus animais" sejam os meus em qualquer papel.
  const { data, error } = await supabase
    .from('pets')
    .select()
    .eq('owner_id', userId)
    .is('archived_at', null)
    .order('created_at', { ascending: false })

  if (error) throw toAppError(error)
  return data
}

/**
 * Um animal pelo id, arquivado ou não — a tela de edição precisa carregar a
 * linha antes de saber em que estado ela está.
 */
/**
 * Um animal pelo id da rota.
 *
 * O filtro por dono repete o que a policy `pets_own` já faz, pelo mesmo motivo
 * de `listMyPets`: o admin enxerga todas as linhas, e o _layout manda admin
 * para a área de tutor — sem o filtro, um id colado na barra abriria o animal
 * de outra pessoa numa tela que oferece editar e remover.
 */
export async function getPet(id: string): Promise<Pet | null> {
  // O id vem da rota, e rota se digita errado: link antigo, notificação de
  // outro aparelho, deep link torto. Sem esta conferência o Postgres responde
  // 22P02 e o tutor lê 'invalid input syntax for type uuid' na tela, em inglês.
  if (!UUID.test(id)) return null

  const userId = await getCurrentUserId()
  if (userId === null) return null

  const { data, error } = await supabase
    .from('pets')
    .select()
    .eq('id', id)
    .eq('owner_id', userId)
    .maybeSingle()

  if (error) throw toAppError(error)
  return data
}

export async function createPet(input: PetInput): Promise<Pet> {
  const userId = await requireUserId()

  const { data, error } = await supabase
    .from('pets')
    .insert({
      // A policy pets_ins exige owner_id = auth.uid(). O dono vem da sessão,
      // nunca da tela: é o que impede cadastrar animal no nome de outra pessoa.
      owner_id: userId,
      ...toColumns(input),
    })
    .select()
    .single()

  if (error) {
    throw readable(
      error,
      'Não foi possível cadastrar o animal com esta conta. Saia e entre de novo no aplicativo.',
    )
  }
  return data
}

/**
 * `owner_id` fica de fora de propósito: dono de animal não muda pelo aplicativo,
 * e mandar a coluna abriria a porta para transferir o animal em um update de
 * formulário. `photo_path` também não vem aqui — ver `setPetPhoto`.
 */
export async function updatePet(id: string, input: PetInput): Promise<Pet> {
  // Só para a sessão vencida ter a mensagem certa. Sem isto o update não
  // acharia linha nenhuma e a pessoa leria que o animal dela sumiu.
  await requireUserId()

  const { data, error } = await supabase
    .from('pets')
    .update(toColumns(input))
    .eq('id', id)
    .select()
    .single()

  if (error) {
    throw readable(
      error,
      'Este animal não é da sua conta. Volte para a lista e escolha um dos seus.',
    )
  }
  return data
}

/**
 * Grava a foto depois do cadastro porque o caminho no bucket é montado com o id
 * do animal — que só existe depois do insert. Separar também evita que uma falha
 * no envio da imagem leve junto o que o tutor digitou.
 */
export async function setPetPhoto(id: string, photoPath: string): Promise<Pet> {
  await requireUserId()

  const { data, error } = await supabase
    .from('pets')
    .update({ photo_path: photoPath })
    .eq('id', id)
    .select()
    .single()

  if (error) {
    throw readable(
      error,
      'Este animal não é da sua conta. Volte para a lista e escolha um dos seus.',
    )
  }
  return data
}

/**
 * Tira o animal de cena sem apagar nada.
 *
 * Nunca DELETE: `service_requests.pet_id` referencia esta linha com `on delete
 * restrict`, então apagar o animal apagaria — ou travaria — o histórico de
 * serviços, que é prova de quem cuidou de quem. O app nem tem permissão de
 * delete em `pets` (0001_schema.sql concede só insert e update); o caminho é
 * marcar a data e parar de listar.
 */
export async function archivePet(id: string): Promise<void> {
  await requireUserId()

  const { error } = await supabase
    .from('pets')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id)
    // Arquivar duas vezes não reescreve a data do primeiro arquivamento, e
    // tocar num animal já arquivado deixa de ser erro — vira nada.
    .is('archived_at', null)

  if (error) {
    throw readable(
      error,
      'Este animal não é da sua conta. Volte para a lista e escolha um dos seus.',
    )
  }
}
