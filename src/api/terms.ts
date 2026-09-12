/**
 * A versão dos Termos que está valendo hoje.
 *
 * ADR decisão 8: o aceite pertence ao PEDIDO, não ao cadastro. Cada linha de
 * `service_requests` guarda `terms_version` e `terms_accepted_at`, para que um
 * dia se possa provar qual texto valia naquele serviço. Quem carimba a versão é
 * o trigger `assert_request_insert`, lendo a linha ativa — o app não manda
 * versão nenhuma no pedido.
 *
 * Então para que serve isto aqui: para a tela MOSTRAR o que está sendo aceito
 * antes do toque. Caixa de aceite sem dizer a versão e sem oferecer o texto não
 * é aceite, é armadilha — e é a versão que aparece na tela que precisa ser a
 * mesma que o servidor vai carimbar.
 *
 * Como em `precoVigente`, os dois fracassos são diferentes:
 *   devolve null     → falei com o servidor e não há nenhuma versão ativa.
 *                      Nada a aceitar, e nada que a pessoa possa fazer: a tela
 *                      não deixa pedir e o problema é de quem publica os Termos.
 *   levanta AppError → não consegui falar com o servidor. A tela oferece
 *                      tentar de novo.
 */
import { supabase, toAppError } from './client'

export type Terms = {
  version: string
  /**
   * O link para ler o texto. Pode ser nulo: hoje a minuta v1.0 vive fora do
   * banco (ver Referências do ADR-001) e a coluna nasceu vazia. A tela precisa
   * continuar de pé sem ele — mostrando a versão e explicando que o texto será
   * enviado —, e NUNCA montar um botão "ler os Termos" que não abre nada.
   */
  bodyUrl: string | null
  publishedAt: string
}

export async function termosAtivos(): Promise<Terms | null> {
  const { data, error } = await supabase
    .from('terms')
    .select('version, body_url, published_at')
    // `maybeSingle` seria arriscado numa tabela qualquer, mas o índice
    // `terms_uma_ativa` garante no máximo uma linha com active = true.
    .eq('active', true)
    .maybeSingle()

  if (error) throw toAppError(error)
  if (data === null) return null

  // Link em branco é ausência de link. Sem isto, `bodyUrl !== null` na tela
  // seria verdadeiro para uma string vazia e o botão de ler os Termos abriria
  // o navegador em lugar nenhum.
  const url = data.body_url?.trim()

  return {
    version: data.version,
    bodyUrl: url === undefined || url === '' ? null : url,
    publishedAt: data.published_at,
  }
}
