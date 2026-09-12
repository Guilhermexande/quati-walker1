/**
 * Perfil do usuário e preferências do passeador.
 *
 * Estas quatro operações são a exceção à regra do SQL (ADR decisão 10): não há
 * RPC de cadastro porque `profiles` e `walker_profiles` não têm regra de
 * negócio a proteger — quem protege são as policies (`id = auth.uid()`) e os
 * triggers-guarda, que revertem papel, verificação, nota e conta do Mercado
 * Pago. Tudo que envolve dinheiro ou estado do serviço continua na RPC.
 */
import type { PostgrestError } from '@supabase/supabase-js'
import { getCurrentUserId } from './auth'
import { AppError, supabase, toAppError } from './client'
import type { Database } from './types.gen'

export type Profile = Database['public']['Tables']['profiles']['Row']
export type WalkerProfile = Database['public']['Tables']['walker_profiles']['Row']

async function requireUserId(): Promise<string> {
  const userId = await getCurrentUserId()
  if (userId === null) {
    throw new AppError('Sua sessão expirou. Entre de novo para continuar.')
  }
  return userId
}

/**
 * `toAppError` repassa a mensagem do servidor porque as RPCs escrevem em
 * português, pensando em quem lê na tela. Constraint e policy não têm esse
 * cuidado: chegam como "duplicate key value violates..." e "new row violates
 * row-level security policy". Estes dois casos ganham texto próprio.
 */
function readable(error: PostgrestError, deniedMessage: string): AppError {
  if (error.code === '23505' && error.message.includes('profiles_cpf_unico')) {
    return new AppError(
      'Esse CPF já está cadastrado em outra conta. Se a conta é sua, entre nela em vez de criar outra.',
    )
  }
  if (error.code === '42501') return new AppError(deniedMessage)
  return toAppError(error)
}

export async function getMyProfile(): Promise<Profile | null> {
  const userId = await getCurrentUserId()
  if (userId === null) return null

  // A policy já limita a linha ao dono, mas o admin enxerga todas — o filtro
  // por id é o que garante que "meu perfil" seja o meu em qualquer papel.
  const { data, error } = await supabase
    .from('profiles')
    .select()
    .eq('id', userId)
    .maybeSingle()

  if (error) throw toAppError(error)
  return data
}

export async function createMyProfile(input: {
  fullName: string
  phoneE164: string
  email: string
  role: 'client' | 'walker'
  cpfDigits?: string
}): Promise<Profile> {
  const userId = await requireUserId()
  const cpf = input.cpfDigits?.trim()

  const { data, error } = await supabase
    .from('profiles')
    .insert({
      // A policy p_ins_own exige id = auth.uid(). O id vem da sessão, nunca da
      // tela: é o que impede criar perfil no lugar de outra pessoa.
      id: userId,
      full_name: input.fullName.trim(),
      phone_e164: input.phoneE164,
      email: input.email.trim().toLowerCase(),
      role: input.role,
      // Cliente não precisa de CPF, e a coluna aceita nulo. String vazia
      // reprovaria na constraint de 11 dígitos.
      cpf_digits: cpf === undefined || cpf === '' ? null : cpf,
    })
    .select()
    .single()

  if (error) {
    throw readable(
      error,
      'Não foi possível criar o seu perfil com esta conta. Saia e entre de novo no aplicativo.',
    )
  }
  return data
}

export async function getMyWalkerProfile(): Promise<WalkerProfile | null> {
  const userId = await getCurrentUserId()
  if (userId === null) return null

  const { data, error } = await supabase
    .from('walker_profiles')
    .select()
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw toAppError(error)
  return data
}

/**
 * Salva as preferências de atendimento do passeador.
 *
 * Upsert porque a tela é a mesma no primeiro preenchimento e na edição, e o
 * passeador não deveria precisar saber a diferença.
 *
 * `mp_user_id`, `verified_at`, `suspended_at` e as notas ficam de fora de
 * propósito: o trigger `guard_walker_profile` devolve esses campos ao valor
 * antigo em qualquer update vindo do app. Mandá-los seria mentir para quem lê
 * o código — o efeito é zero.
 */
export async function saveWalkerProfile(input: {
  bio?: string
  radiusM: number
  acceptsDog: boolean
  acceptsCat: boolean
  acceptsLargeDog: boolean
}): Promise<WalkerProfile> {
  const userId = await requireUserId()

  // `bio` é opcional na assinatura, e uma tela que só mexe no raio não a manda.
  // Incluí-la sempre no upsert gravava null por cima da apresentação que o
  // passeador escreveu — apagava o texto dele a cada ajuste de preferência.
  // Aqui ela entra no payload apenas quando veio de verdade.
  const bio = input.bio?.trim()
  const campoBio = bio === undefined ? {} : { bio: bio === '' ? null : bio }

  const { data, error } = await supabase
    .from('walker_profiles')
    .upsert(
      {
        user_id: userId,
        ...campoBio,
        radius_m: input.radiusM,
        accepts_dog: input.acceptsDog,
        accepts_cat: input.acceptsCat,
        accepts_large_dog: input.acceptsLargeDog,
      },
      { onConflict: 'user_id' },
    )
    .select()
    .single()

  if (error) {
    // A policy wp_ins_own exige my_role() = 'walker': sem perfil de passeador
    // gravado antes, a inserção é recusada por permissão, não por dado inválido.
    throw readable(
      error,
      'Termine o seu cadastro como passeador antes de salvar estas preferências.',
    )
  }
  return data
}
