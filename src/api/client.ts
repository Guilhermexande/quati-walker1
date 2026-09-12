/**
 * O ÚNICO lugar do app que instancia o Supabase.
 *
 * Regra de arquitetura (ADR decisão 10): nenhum componente, tela ou hook fora
 * de `src/api/` importa `@supabase/supabase-js`. Se um import desses aparecer
 * em `app/` ou `src/components/`, é bug de arquitetura, não estilo.
 */
import 'react-native-url-polyfill/auto'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createClient } from '@supabase/supabase-js'
import type { Database } from './types.gen'

const url = process.env.EXPO_PUBLIC_SUPABASE_URL
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY

if (!url || !anonKey) {
  throw new Error(
    'Faltam EXPO_PUBLIC_SUPABASE_URL e EXPO_PUBLIC_SUPABASE_ANON_KEY. ' +
      'Copie .env.example para .env e preencha.',
  )
}

export const supabase = createClient<Database>(url, anonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    // O app não usa links de callback no navegador; a sessão vem do storage.
    detectSessionInUrl: false,
  },
})

/**
 * Traduz erro do Postgres para mensagem que uma pessoa entende.
 *
 * As funções RPC levantam exceção com `hint` para os casos que a tela precisa
 * tratar de forma diferente — ver 0002_rpc.sql.
 */
export type AppErrorHint = 'ja_aceito' | 'pagar_antes' | 'sem_mp' | null

export class AppError extends Error {
  readonly hint: AppErrorHint
  constructor(message: string, hint: AppErrorHint = null) {
    super(message)
    this.name = 'AppError'
    this.hint = hint
  }
}

type PostgrestLike = { message?: string; hint?: string | null; code?: string }

export function toAppError(error: unknown): AppError {
  const e = error as PostgrestLike | null

  if (!e) return new AppError('Algo deu errado. Tente de novo.')

  const hint = (e.hint ?? null) as AppErrorHint

  // Erros de rede não têm mensagem útil do servidor.
  if (e.message?.includes('Network request failed')) {
    return new AppError('Sem conexão. Verifique a internet e tente de novo.')
  }

  // `raise exception` no Postgres chega com a mensagem em português, escrita
  // no 0002_rpc.sql pensando em quem vai ler na tela.
  if (e.message) return new AppError(e.message, hint)

  return new AppError('Algo deu errado. Tente de novo.')
}
