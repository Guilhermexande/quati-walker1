/**
 * Entrar, sair e saber se alguém está logado. Nada além disso.
 *
 * Quem a pessoa é dentro do Quati Walker — tutor ou passeador, nome, telefone —
 * mora em public.profiles e é assunto de profiles.ts. O Supabase Auth só
 * responde "existe uma conta com esse e-mail e esta senha confere".
 */
import { AppError, supabase, toAppError } from './client'

type AuthErrorLike = { code?: string; message?: string }

/**
 * O Supabase Auth responde sempre em inglês, e com frase de programador.
 * Quem vai ler é um tutor no ponto de ônibus: precisa saber o que houve e o
 * que fazer em seguida.
 */
function codigoDoErro(error: AuthErrorLike): string {
  if (error.code) return error.code

  // Versões antigas do supabase-js não mandam `code`; sobra o texto.
  const texto = error.message ?? ''
  if (texto.includes('Invalid login credentials')) return 'invalid_credentials'
  if (texto.includes('Email not confirmed')) return 'email_not_confirmed'
  if (texto.includes('User already registered')) return 'user_already_exists'
  if (texto.includes('Password should be')) return 'weak_password'
  if (texto.includes('Auth session missing')) return 'session_not_found'
  return ''
}

function mensagemEmPortugues(codigo: string): string | null {
  switch (codigo) {
    case 'invalid_credentials':
      return 'E-mail ou senha não conferem. Confira os dois e tente de novo.'
    case 'email_not_confirmed':
      return 'Falta confirmar seu e-mail. Abra o link que enviamos para você — olhe também a caixa de spam.'
    case 'user_already_exists':
    case 'email_exists':
      return 'Já existe uma conta com esse e-mail. Entre com a sua senha.'
    case 'weak_password':
      return 'Senha muito fácil de descobrir. Use pelo menos 8 caracteres, misturando letras e números.'
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
      return 'Muitas tentativas seguidas. Espere alguns minutos e tente outra vez.'
    case 'validation_failed':
      return 'E-mail inválido. Confira o endereço e tente de novo.'
    default:
      return null
  }
}

function toAuthError(error: unknown): AppError {
  const e = (error as AuthErrorLike | null) ?? {}
  const traduzida = mensagemEmPortugues(codigoDoErro(e))

  // Mesmo traduzido o erro passa pelo toAppError: é lá que mora o tratamento
  // de queda de conexão, e é ele que devolve sempre um AppError para a tela.
  return toAppError(traduzida === null ? error : { message: traduzida })
}

// Teclado de celular gosta de mandar espaço no fim e maiúscula no começo.
function normalizarEmail(email: string): string {
  return email.trim().toLowerCase()
}

export async function signUpWithEmail(email: string, password: string): Promise<string> {
  const { data, error } = await supabase.auth.signUp({
    email: normalizarEmail(email),
    password,
  })
  if (error) throw toAuthError(error)

  const user = data.user
  if (!user) {
    throw new AppError('Não foi possível criar a conta agora. Tente de novo em alguns minutos.')
  }

  // Com confirmação de e-mail ligada, cadastrar um endereço que já existe não
  // devolve erro nenhum: o Supabase responde um usuário de fachada, sem
  // identidade, de propósito — para não contar a estranhos quem tem conta aqui.
  // A lista de identidades vazia é a única pista de que a conta já existia.
  if (user.identities?.length === 0) {
    throw new AppError('Já existe uma conta com esse e-mail. Entre com a sua senha.')
  }

  // Sem sessão não há auth.uid(), e o passo seguinte — criar o perfil — bate na
  // RLS e falha com uma mensagem que ninguém entende. Melhor dizer aqui o que
  // ainda falta.
  if (!data.session) {
    throw new AppError(
      'Conta criada. Confirme o e-mail que enviamos e depois entre com a sua senha.',
    )
  }

  return user.id
}

export async function signInWithEmail(email: string, password: string): Promise<string> {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: normalizarEmail(email),
    password,
  })
  if (error) throw toAuthError(error)

  if (!data.user) {
    throw new AppError('Não foi possível entrar agora. Tente de novo em alguns minutos.')
  }
  return data.user.id
}

export async function signOut(): Promise<void> {
  // Precisa de internet: sair invalida o token no servidor, não só no aparelho.
  const { error } = await supabase.auth.signOut()

  // Sair sem ter sessão não é falha — a pessoa queria ficar de fora, e está.
  if (error && codigoDoErro(error as AuthErrorLike) !== 'session_not_found') {
    throw toAuthError(error)
  }
}

export async function getCurrentUserId(): Promise<string | null> {
  const { data, error } = await supabase.auth.getSession()

  // Isto é leitura do armazenamento do aparelho. Se falhar, a resposta honesta
  // é "ninguém entrou": a pessoa entra de novo e segue a vida. Erro de storage
  // na abertura do app só daria uma tela de erro sem saída.
  if (error) return null

  return data.session?.user.id ?? null
}

/**
 * Avisa toda vez que a sessão muda: entrou, saiu, token renovado, token que
 * venceu de vez. Devolve a função de cancelar a inscrição — o _layout chama
 * ela ao desmontar.
 *
 * O supabase dispara um evento com a sessão guardada assim que a inscrição
 * começa. É por isso que a abertura do app não precisa chamar getCurrentUserId
 * antes: o primeiro aviso já chega sozinho.
 *
 * Cuidado ao escrever o callback: não espere por outra chamada do supabase
 * dentro dele. O supabase segura uma trava enquanto avisa os inscritos, e
 * esperar ali dentro trava o app.
 */
export function onAuthChange(cb: (userId: string | null) => void): () => void {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    cb(session?.user.id ?? null)
  })

  return () => data.subscription.unsubscribe()
}
