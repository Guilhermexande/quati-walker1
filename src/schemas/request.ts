/**
 * Validação do pedido de serviço e os textos que a tela precisa.
 *
 * Os limites daqui são os mesmos do banco (0001_schema.sql e 0002_rpc.sql):
 * a espécie decide o serviço (`assert_service_matches_species`), o horário
 * precisa estar à frente do mínimo do banco e o endereço precisa ter coordenada
 * (`assert_request_insert`). Repetir a regra na tela não é duplicação inútil —
 * é o que faz a pessoa ler "escolha um horário mais à frente" embaixo do campo
 * certo, em vez de descobrir a exigência quando já apertou o botão.
 *
 * O banco continua sendo a última palavra. Nada aqui autoriza nada.
 */
import { z } from 'zod'

type Especie = 'dog' | 'cat'
type Servico = 'walk' | 'visit'

/**
 * Os mesmos oito valores do enum `request_status`.
 *
 * Escritos à mão, como em pet.ts: `src/schemas` não importa de `src/api`. Quem
 * cobra a correspondência é o compilador na tela — o status chega tipado de
 * `types.gen`, e um estado novo no banco quebraria a chamada de
 * `descricaoDoStatus` antes de virar um card em branco para o usuário.
 */
export type StatusDoPedido =
  | 'requested'
  | 'reserved'
  | 'confirmed'
  | 'in_progress'
  | 'completed'
  | 'expired'
  | 'cancelled_client'
  | 'cancelled_walker'

/** Mesma antecedência exigida pelo trigger `assert_request_insert`. */
const ANTECEDENCIA_MINIMA_MIN = 15

/** Mesma janela do split de cancelamento no `assert_status_transition`. */
const HORAS_PARA_REEMBOLSO_INTEIRO = 2

/** Estados em que o serviço já foi pago — os únicos com dinheiro a dividir. */
const JA_PAGOS: readonly StatusDoPedido[] = ['confirmed', 'in_progress']

// =============================================================================
// Serviço e espécie
// =============================================================================

/**
 * Gato não passeia, cão não recebe visita (ADR decisão 1).
 *
 * A escolha do serviço não é da pessoa: ela escolhe o animal, e o serviço vem
 * junto. Oferecer as duas opções para um gato seria oferecer um caminho que o
 * trigger `assert_service_matches_species` vai recusar no fim.
 */
export function servicoDoAnimal(species: Especie): Servico {
  return species === 'cat' ? 'visit' : 'walk'
}

export function nomeDoServico(service: Servico): string {
  return service === 'walk' ? 'passeio' : 'visita em casa'
}

// =============================================================================
// Dinheiro
// =============================================================================

/** "4000" vira "4.000". Sem isto, R$ 1.200,00 aparece como R$ 1200,00. */
function comPontoDeMilhar(numero: number): string {
  const digitos = `${numero}`
  const grupos: string[] = []
  for (let fim = digitos.length; fim > 0; fim -= 3) {
    grupos.unshift(digitos.slice(Math.max(0, fim - 3), fim))
  }
  return grupos.join('.')
}

/**
 * Centavos em reais, escrito à mão.
 *
 * `Intl.NumberFormat` seria o caminho curto, mas o Hermes entrega o ICU em
 * versões diferentes conforme o aparelho e a build: o mesmo valor sai "R$ 40,00"
 * num Android e "R$40,00" — ou com espaço estreito no meio — em outro. Preço é
 * a informação que a pessoa mais confere antes de confirmar; ela não pode mudar
 * de cara de celular para celular.
 *
 * Isto NÃO calcula preço: o número já vem do banco, por `price_cents`.
 */
export function reais(centavos: number): string {
  // Valor que não é número é bug de quem chamou, e "R$ NaN,NaN" na tela faz a
  // pessoa desconfiar do app inteiro. Dizer que não temos o valor é honesto.
  if (!Number.isFinite(centavos)) return 'valor indisponível'

  const inteiro = Math.trunc(centavos)
  const sinal = inteiro < 0 ? '-' : ''
  const absoluto = Math.abs(inteiro)
  const unidades = comPontoDeMilhar(Math.floor(absoluto / 100))
  const resto = `${absoluto % 100}`.padStart(2, '0')

  return `${sinal}R$ ${unidades},${resto}`
}

// =============================================================================
// Estado do pedido
// =============================================================================

const ESTADOS: Record<StatusDoPedido, { titulo: string; explicacao: string }> = {
  requested: {
    titulo: 'Procurando quem atenda',
    explicacao:
      'Seu pedido está à vista dos passeadores da região. Assim que alguém aceitar, você recebe um aviso para pagar.',
  },
  // O pagamento por PIX é o Épico 5 e AINDA NÃO EXISTE no aplicativo. Enquanto
  // não existir, este texto não pode mandar pagar: a pessoa procura o botão,
  // não acha, o prazo vence — e três vencimentos em 30 dias fazem
  // `clients_pay_first` bloquear novos pedidos dela. Seria o aplicativo punindo
  // alguém por uma porta que ele nunca abriu.
  reserved: {
    titulo: 'Aceito — aguardando o pagamento',
    explicacao:
      'Alguém aceitou e está segurando o horário. O pagamento por PIX ainda não está no aplicativo: vamos combinar com você por fora até ele chegar. Você não precisa procurar botão nenhum aqui.',
  },
  confirmed: {
    titulo: 'Confirmado',
    explicacao: 'O pagamento entrou e o serviço está garantido para o horário marcado.',
  },
  in_progress: {
    titulo: 'Acontecendo agora',
    explicacao: 'Já começou. Quando terminar, você recebe um aviso aqui.',
  },
  completed: {
    titulo: 'Concluído',
    explicacao: 'O serviço foi encerrado. Você pode contar como foi para ajudar outras pessoas.',
  },
  // Dois caminhos diferentes terminam aqui: ninguém aceitou até a hora marcada,
  // ou aceitaram e o pagamento não saiu em 10 minutos. A explicação cobre os
  // dois — do lado de fora, a diferença não muda o que a pessoa faz agora.
  expired: {
    titulo: 'Venceu',
    explicacao:
      'Este pedido venceu: ou ninguém aceitou a tempo, ou o pagamento não saiu dentro dos 10 minutos. Se ainda quiser o serviço, faça um pedido novo.',
  },
  cancelled_client: {
    titulo: 'Cancelado por você',
    explicacao:
      'Você cancelou este serviço. Se já havia pagamento, o valor de volta é o que está escrito neste pedido.',
  },
  cancelled_walker: {
    titulo: 'Cancelado por quem ia atender',
    explicacao:
      'Quem tinha aceitado desmarcou. Se você já tinha pago, o valor volta inteiro. Pode fazer um pedido novo quando quiser.',
  },
}

export function descricaoDoStatus(status: StatusDoPedido): {
  titulo: string
  explicacao: string
} {
  return ESTADOS[status]
}

/**
 * Espelha as duas recusas de `cancel_request` em 0002_rpc.sql: estado final
 * ('este serviço já está encerrado') e serviço em andamento, que só sai daqui
 * pela porta de incidente.
 *
 * Lista positiva de propósito: estado novo no banco nasce impedido de cancelar,
 * e quem for mexer precisa vir aqui decidir. O contrário — lista de proibidos —
 * deixaria o estado novo cancelável por esquecimento.
 */
export function podeCancelar(status: StatusDoPedido): boolean {
  return status === 'requested' || status === 'reserved' || status === 'confirmed'
}

/**
 * Quanto volta se cancelar agora.
 *
 * Copiado linha a linha do `assert_status_transition` (0001_schema.sql), e
 * conferido contra um Postgres de verdade:
 *
 *   nunca pago (requested, reserved)  → refund_cents = 0
 *   pago, 2 h ou mais de antecedência → refund_cents = price_cents
 *   pago, menos de 2 h                → refund_cents = price_cents / 2
 *
 * A divisão é inteira e trunca, como a do Postgres: com price_cents = 4001 o
 * banco devolve 2000, não 2000,5 nem 2001.
 *
 * A conta das horas usa o relógio do aparelho; a do banco usa o relógio dele. A
 * tela MOSTRA, o banco DECIDE — e é por isso que a tela relê o pedido depois de
 * cancelar, em vez de dar o valor daqui como final.
 *
 * O estado é OBRIGATÓRIO, e já foi opcional com padrão 'confirmed'. O padrão
 * era o valor perigoso: quem chamasse com dois argumentos — a assinatura que o
 * contrato do épico publicou — receberia "o valor volta inteiro" para um pedido
 * em 'requested', que o banco reembolsa com zero. A tela prometeria dinheiro
 * que nunca saiu da conta de ninguém. Errar agora é erro de compilação.
 */
export function reembolsoSeCancelarAgora(
  priceCents: number,
  scheduledAt: string,
  status: StatusDoPedido,
): { centavos: number; explicacao: string } {
  if (!JA_PAGOS.includes(status)) {
    return {
      centavos: 0,
      explicacao: 'Você ainda não pagou nada por este serviço. Cancelar agora não custa nada.',
    }
  }

  const metade = Math.trunc(priceCents / 2)
  const horario = new Date(scheduledAt).getTime()

  // Horário ilegível é bug, não situação. "Pelo menos metade" continua verdade
  // nos dois ramos possíveis, e o valor exato vem do banco logo em seguida.
  if (Number.isNaN(horario)) {
    return {
      centavos: metade,
      explicacao: `Não conseguimos conferir o horário deste serviço. Cancelando agora, volta pelo menos ${reais(metade)} — o valor exato aparece assim que o cancelamento for registrado.`,
    }
  }

  const horasQueFaltam = (horario - Date.now()) / 3_600_000

  if (horasQueFaltam >= HORAS_PARA_REEMBOLSO_INTEIRO) {
    return {
      centavos: priceCents,
      explicacao: `Faltam mais de 2 horas para o horário marcado, então o valor volta inteiro para você: ${reais(priceCents)}.`,
    }
  }

  return {
    centavos: metade,
    explicacao: `Falta menos de 2 horas para o horário marcado. Nesse caso volta metade do valor: ${reais(metade)}.`,
  }
}

// =============================================================================
// O formulário
// =============================================================================

/**
 * A pessoa nunca digita latitude nem longitude — elas vêm do endereço de um
 * pedido anterior ou do GPS. Por isso a mensagem fala de endereço, e não de
 * coordenada: "longitude inválida" não diz a ninguém o que fazer em seguida.
 */
const SEM_COORDENADA =
  'Ainda não sabemos onde fica este endereço. Use o endereço de um pedido anterior, ou confirme que você está no local do serviço agora.'

function grauEntre(limite: number) {
  return z
    .number({ errorMap: () => ({ message: SEM_COORDENADA }) })
    .finite(SEM_COORDENADA)
    .min(-limite, SEM_COORDENADA)
    .max(limite, SEM_COORDENADA)
}

/** Minutos entre agora e o horário escolhido, ou null se não for data de verdade. */
function minutosAte(iso: string): number | null {
  const alvo = new Date(iso).getTime()
  if (Number.isNaN(alvo)) return null
  return (alvo - Date.now()) / 60_000
}

export const requestSchema = z
  .object({
    petId: z.string().uuid('Escolha o animal que vai ser atendido.'),

    // Não é escolha de ninguém: sai de `servicoDoAnimal`, pela espécie. Fica no
    // esquema porque é o que vai para o servidor, e o que vai para o servidor
    // se confere antes de sair.
    service: z.enum(['walk', 'visit'], {
      errorMap: () => ({
        message: 'Não deu para saber se é passeio ou visita em casa. Escolha o animal de novo.',
      }),
    }),

    // Sem número escrito aqui de propósito: quais durações existem é a tabela
    // `pricing` que diz, e a tela monta as opções com o que ela devolver.
    duracaoMin: z
      .number({ errorMap: () => ({ message: 'Escolha quanto tempo o serviço vai durar.' }) })
      .int('Escolha quanto tempo o serviço vai durar.')
      .positive('Escolha quanto tempo o serviço vai durar.'),

    enderecoTexto: z
      .string()
      .trim()
      .min(5, 'Escreva o endereço com rua e número.')
      .max(
        200,
        'Ficou longo demais. Escreva rua, número e o ponto de referência que ajuda a achar a porta.',
      ),

    lat: grauEntre(90),
    lng: grauEntre(180),

    // ISO 8601 com fuso — o que `toISOString()` devolve sobre o Date montado
    // com o dia e a hora que a pessoa escolheu no aparelho dela.
    quando: z.string().min(1, 'Escolha o dia e o horário do serviço.'),

    // Nasce false, sempre, e precisa virar true pela mão da pessoa. Caixa
    // pré-marcada não é aceite (ADR decisão 8): o que fica gravado em
    // `terms_version` é prova de qual texto valia naquele serviço, e prova só
    // vale se alguém tiver mesmo dito sim.
    aceitouTermos: z.literal(true, {
      errorMap: () => ({
        message: 'Para pedir o serviço, marque que você leu e aceita os Termos de Uso.',
      }),
    }),
  })
  .superRefine((value, ctx) => {
    // (0, 0) é o Atlântico na altura da África. Nunca é um endereço em Foz — é o
    // que sobra quando a leitura de GPS falha e alguém preencheu zero no lugar.
    // Sem esta checagem o pedido nasce certinho e nenhum passeador o enxerga.
    if (value.lat === 0 && value.lng === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['enderecoTexto'],
        message: SEM_COORDENADA,
      })
    }

    const minutos = minutosAte(value.quando)

    if (minutos === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['quando'],
        message: 'Escolha o dia e o horário do serviço.',
      })
      return
    }

    // Mesma régua do trigger `assert_request_insert`, que recusa horário a 15
    // minutos ou menos. O banco compara com o relógio dele e continua sendo a
    // última palavra; isto existe para a pessoa ler o aviso antes de confirmar.
    if (minutos <= ANTECEDENCIA_MINIMA_MIN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['quando'],
        message:
          // O banco recusa a 15 minutos (`assert_request_insert`), mas a tela
          // pede uma hora de folga e é essa a regra que a pessoa leu. Repetir
          // aqui o número do banco a mandaria marcar para daqui a 30 minutos e
          // ser barrada de novo pelo passo do horário — obedecendo o que o
          // aplicativo pediu.
          'Escolha um horário com pelo menos uma hora de folga. É o tempo de alguém ver o seu pedido, aceitar e conseguir chegar até você.',
      })
    }
  })

export type RequestFormInput = z.infer<typeof requestSchema>
