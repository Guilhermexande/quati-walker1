/**
 * O preço — que o app lê, mostra e nunca calcula.
 *
 * ADR decisão 2: `pricing` é versionada por `active_from` / `active_to`, e quem
 * deriva preço, comissão e repasse de um pedido é o trigger
 * `assert_request_insert` (0001_schema.sql). Esta função existe para UM fim: a
 * tela poder mostrar o valor ANTES de a pessoa confirmar. O número que ela
 * devolve não vai — nem pode ir — dentro de `create_service_request`.
 *
 * Se um dia o preço daqui divergir do que o servidor cobrou, quem está certo é
 * o servidor. A linha de `service_requests` guarda o snapshot dele.
 *
 * COMO QUEM CHAMA DISTINGUE OS DOIS FRACASSOS — e são fracassos diferentes:
 *
 *   devolve null   → falei com o servidor e NÃO EXISTE preço vigente para este
 *                    serviço nesta duração. A tela diz que o serviço está
 *                    indisponível no momento e não deixa pedir. Tentar de novo
 *                    não adianta: falta uma linha em `pricing`.
 *
 *   levanta AppError → NÃO CONSEGUI falar com o servidor (queda de rede, sessão
 *                    vencida, banco fora do ar). A tela diz que não conseguiu
 *                    carregar o valor e oferece TENTAR DE NOVO — e também não
 *                    deixa pedir, porque pedir sem saber o preço é pedir no
 *                    escuro.
 *
 * Por isso a assinatura devolve `Pricing | null` em vez de engolir a falha num
 * null só: com `usePrecoVigente`, o React Query entrega `data === null` no
 * primeiro caso e `isError` no segundo. Uma tela que tratasse os dois iguais
 * mandaria a tutora ficar tentando de novo por um preço que não existe.
 */
import { supabase, toAppError } from './client'
import type { Database } from './types.gen'

type ServiceType = Database['public']['Enums']['service_type']

export type Pricing = {
  id: string
  service: ServiceType
  durationMinutes: number
  priceCents: number
  commissionBps: number
}

/**
 * A linha de preço em vigor agora para este serviço e esta duração.
 *
 * A janela é a mesma da função `current_pricing` do 0001_schema.sql —
 * `active_from <= agora` e (`active_to` nulo ou no futuro) — de propósito: é
 * aquela função que o trigger usa na hora de cobrar. As duas precisam enxergar
 * a mesma linha, ou a tela mostra um valor e o pedido sai com outro.
 */
export async function precoVigente(
  service: ServiceType,
  duracaoMin: number,
): Promise<Pricing | null> {
  // O relógio é o do aparelho, e o do servidor é o que vale. Aqui a diferença
  // é inofensiva: preço troca de faixa raramente, e um relógio errado faz a
  // tela mostrar valor velho ou não achar preço nenhum — nunca faz o pedido
  // sair mais barato, porque quem carimba o valor é o trigger.
  const agora = new Date().toISOString()

  const { data, error } = await supabase
    .from('pricing')
    .select('id, service, duration_minutes, price_cents, commission_bps')
    .eq('service', service)
    .eq('duration_minutes', duracaoMin)
    .lte('active_from', agora)
    // Aspas no valor porque a data ISO tem pontos, e ponto é o separador desta
    // sintaxe de filtro: sem elas o servidor lê 'active_to.gt.2026-09-12T18'
    // e o resto vira lixo.
    .or(`active_to.is.null,active_to.gt."${agora}"`)
    // A constraint `pricing_sem_sobreposicao` já garante uma única linha
    // vigente por serviço e duração. A ordem repete a de `current_pricing` para
    // que, se um dia a constraint mudar, as duas escolham a mesma linha.
    .order('active_from', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw toAppError(error)
  if (data === null) return null

  return {
    id: data.id,
    service: data.service,
    durationMinutes: data.duration_minutes,
    priceCents: data.price_cents,
    commissionBps: data.commission_bps,
  }
}
