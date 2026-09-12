/**
 * Validação do cadastro de animal e as contas de data que a tela precisa.
 *
 * Os limites daqui são os mesmos do banco (0001_schema.sql): a constraint
 * `dog_requires_size` e o trigger `assert_request_insert`, que recusa o pedido
 * de serviço sem vacina antirrábica válida (Termos §8). O banco é a última
 * palavra, mas responde em linguagem de Postgres. Estas regras existem para o
 * tutor ler "Escolha o porte do cão" embaixo do campo certo, e não descobrir a
 * exigência quando já estiver tentando marcar um passeio.
 */
import { z } from 'zod'

type PetSize = 'small' | 'medium' | 'large'

/** Formato da coluna `rabies_valid_until`, que é `date` — não `timestamptz`. */
const DATA_ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

/**
 * Quebra 'AAAA-MM-DD' em números, ou devolve null se não for data de verdade.
 *
 * O valor padrão `NaN` no destructuring cobre o caso impossível de o split não
 * render três pedaços: sem ele o tipo seria `number | undefined` e a alternativa
 * seria um `!` mentindo para quem lê.
 */
function partesDaData(iso: string): { ano: number; mes: number; dia: number } | null {
  if (!DATA_ISO.test(iso)) return null

  const [ano = NaN, mes = NaN, dia = NaN] = iso.split('-').map(Number)
  if (Number.isNaN(ano) || Number.isNaN(mes) || Number.isNaN(dia)) return null

  // 31 de fevereiro passa na expressão regular e não existe no calendário. O
  // Date local — nunca o UTC — normaliza a data inválida para outro dia, e é
  // essa diferença que denuncia o engano.
  const data = new Date(ano, mes - 1, dia)
  const real =
    data.getFullYear() === ano && data.getMonth() === mes - 1 && data.getDate() === dia

  return real ? { ano, mes, dia } : null
}

/**
 * Hoje no fuso do aparelho, em 'AAAA-MM-DD'.
 *
 * `toISOString()` devolveria UTC: em Foz (UTC-3) toda consulta feita depois das
 * 21h cairia no dia seguinte, e a vacina apareceria vencida um dia antes da
 * hora para quem abre o app à noite.
 */
function hojeISO(): string {
  const agora = new Date()
  const mes = `${agora.getMonth() + 1}`.padStart(2, '0')
  const dia = `${agora.getDate()}`.padStart(2, '0')
  return `${agora.getFullYear()}-${mes}-${dia}`
}

/**
 * A vacina antirrábica está vencida?
 *
 * Mesma régua do trigger `assert_request_insert`: sem data informada conta como
 * vencida, e o dia da validade ainda vale (o banco compara com `< current_date`).
 * Data que não dá para entender também conta como vencida — prometer que está em
 * dia e o pedido ser recusado depois é pior do que avisar cedo demais.
 *
 * Só compara texto porque 'AAAA-MM-DD' com zero à esquerda já ordena sozinho, e
 * converter para Date traria o fuso de volta ao problema.
 */
export function vacinaEstaVencida(rabiesValidUntil: string | null): boolean {
  if (rabiesValidUntil === null) return true

  const data = rabiesValidUntil.trim()
  if (data === '' || partesDaData(data) === null) return true

  return data < hojeISO()
}

/**
 * Peso aproximado em vez de só o nome do porte: quem tem vira-lata não sabe
 * dizer se ele é médio ou grande, e o porte errado manda o animal para um
 * passeador que não aceita cachorro grande.
 *
 * A referência é o colo, e não a raça, de propósito: quem tem vira-lata não
 * compara o próprio cachorro com um border collie, e quase ninguém pesou o
 * animal em casa. Levantar no colo é um teste que a pessoa já fez sem querer,
 * e acerta a faixa em praticamente todos os casos.
 */
const PORTES: Record<PetSize, string> = {
  small: 'Pequeno — até 10 kg. Você levanta ele no colo com um braço só',
  medium: 'Médio — de 10 a 25 kg. Dá para pegar no colo, mas com os dois braços',
  large: 'Grande — mais de 25 kg. Pesado demais para carregar no colo',
}

/**
 * Aceita nulo porque `pets.size` é nulo para gato. Exigir porte aqui obrigaria
 * cada tela que lista animais a um `!` para poder chamar esta função.
 */
export function descricaoDoPorte(size: PetSize | null): string {
  if (size === null) return 'Porte não informado'
  return PORTES[size]
}

/**
 * Campo de texto que a pessoa pode deixar em branco.
 *
 * Sai sempre como `string` com conteúdo ou `null`, nunca como `''`: string vazia
 * gravada no banco vira "raça: " em branco na tela do passeador, que é diferente
 * de "não informou".
 */
function textoOpcional(max: number, mensagemLonga: string) {
  return z
    .string()
    .trim()
    .max(max, mensagemLonga)
    .nullish()
    .transform((texto) => (texto === null || texto === undefined || texto === '' ? null : texto))
}

export const petSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Escreva o nome do animal.')
      .max(60, 'Nome longo demais. Use o nome pelo qual ele atende.'),

    species: z.enum(['dog', 'cat'], {
      errorMap: () => ({ message: 'Escolha uma opção: cachorro ou gato.' }),
    }),

    size: z
      .enum(['small', 'medium', 'large'], {
        errorMap: () => ({ message: 'Escolha o porte do cão.' }),
      })
      .nullish()
      .transform((porte) => porte ?? null),

    breed: textoOpcional(
      60,
      'Escreva só o nome da raça. Se for vira-lata, pode deixar em branco.',
    ),

    // A tela manda 'AAAA-MM-DD' porque a coluna é `date`. Data vencida NÃO é
    // erro de formulário: o tutor precisa conseguir cadastrar o animal hoje e
    // levar a carteirinha ao veterinário depois. Quem avisa que está vencida é
    // `vacinaEstaVencida`, na tela, antes de ele tentar pedir o serviço.
    rabiesValidUntil: z
      .string()
      .trim()
      .nullish()
      .transform((data) => (data === null || data === undefined || data === '' ? null : data))
      .refine(
        (data) => data === null || partesDaData(data) !== null,
        'Confira a data de validade da vacina, como está na carteirinha.',
      ),

    riskNotes: textoOpcional(
      1000,
      // Contar caracteres não é trabalho de quem escreve sobre o próprio
      // animal. A mensagem diz o que fazer, não o número que estourou.
      'Ficou longo demais. Conte só o que quem for cuidar dele precisa saber no dia: o que ele faz, do que tem medo, e o remédio que toma.',
    ),
  })
  .superRefine((value, ctx) => {
    // Espelha a constraint `dog_requires_size`. O porte decide quem pode
    // atender: passeador que não marcou "aceita cachorro grande" não recebe o
    // pedido. Por isso ele é obrigatório aqui, e não um detalhe a preencher depois.
    if (value.species === 'dog' && value.size === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['size'],
        message: 'Escolha o porte do cão.',
      })
    }

    if (value.rabiesValidUntil === null) return

    const partes = partesDaData(value.rabiesValidUntil)
    if (partes === null) return

    // Ano digitado errado ("2206") passaria como data válida e faria a vacina
    // parecer em dia por dois séculos. A antirrábica vale de um a três anos.
    const anoAtual = new Date().getFullYear()
    if (partes.ano < 2000 || partes.ano > anoAtual + 10) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rabiesValidUntil'],
        message: 'Confira o ano da validade da vacina na carteirinha.',
      })
    }
  })

export type PetFormInput = z.infer<typeof petSchema>
