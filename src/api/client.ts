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
 * `AppError` e `toAppError` foram para src/lib/erros.ts e são reexportados aqui.
 *
 * O motivo está escrito lá: um arquivo que só precisa da classe de erro não pode
 * ser obrigado a carregar o Supabase inteiro — e este módulo levanta na carga
 * quando faltam as variáveis do .env. A reexportação existe para que todo
 * `src/api/` continue importando de um lugar só.
 */
export { AppError, toAppError, type AppErrorHint } from '@/lib/erros'
