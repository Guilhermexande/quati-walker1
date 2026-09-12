/**
 * O erro que a tela sabe mostrar.
 *
 * Mora em `src/lib/` e não em `src/api/` por um motivo concreto: quem só quer a
 * classe de erro não pode ser obrigado a carregar o Supabase junto. O módulo
 * `src/api/client.ts` instancia o cliente, o AsyncStorage e o polyfill de URL na
 * carga — e LEVANTA na hora se faltar EXPO_PUBLIC_SUPABASE_URL ou ANON_KEY.
 * `src/lib/localizacao.ts`, que não fala com o servidor, arrastava tudo isso
 * atrás de si só para poder errar com uma mensagem legível.
 *
 * `src/api/client.ts` reexporta os dois nomes daqui, então nada em `src/api/`
 * precisou mudar de import.
 */

/**
 * O que a RPC quis dizer além da frase.
 *
 * As funções de 0002_rpc.sql levantam exceção com `hint` nos casos em que a tela
 * precisa fazer algo diferente de só mostrar o texto — por exemplo, apagar o
 * botão de pedir em vez de convidar a tentar de novo.
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

/** Traduz erro do Postgres para mensagem que uma pessoa entende. */
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
