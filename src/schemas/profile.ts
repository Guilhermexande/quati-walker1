/**
 * Validação de formulário e normalização do que a pessoa digita.
 *
 * Os limites daqui são os mesmos do banco (0001_schema.sql): telefone em E.164,
 * CPF com 11 dígitos, raio entre 500 m e 20 km. Repetir a regra na tela não é
 * duplicação inútil — é o que faz o usuário ver "confira o DDD" em vez de
 * descobrir o limite por uma mensagem crua do Postgres.
 */
import { z } from 'zod'

/** Mesma expressão da constraint `profiles.phone_e164`. */
const E164 = /^\+[1-9][0-9]{7,14}$/

function onlyDigits(value: string): string {
  return value.replace(/\D/g, '')
}

/**
 * Converte o que o brasileiro escreve — "(45) 99999-0000", "45 9 9999 0000",
 * "045 99999-0000" — no formato que o banco exige.
 *
 * Não levanta erro: devolver a melhor conversão possível e deixar o esquema
 * reprovar mantém a mensagem de erro perto do campo, na língua do usuário.
 */
export function toE164(raw: string): string {
  const typed = raw.trim()
  const digits = onlyDigits(typed)
  if (digits === '') return ''

  // Quem digitou "+" já informou o código do país. Foz faz fronteira com
  // Paraguai e Argentina; adivinhar +55 por cima estragaria esses números.
  if (typed.startsWith('+')) return `+${digits}`

  // O zero de operadora ("045", "0800") não existe em E.164.
  const national = digits.replace(/^0+/, '')

  // Com 12 ou 13 dígitos, o "55" da frente é o código do Brasil. Com menos que
  // isso ele é o DDD de Santa Maria e o número ainda é nacional — por isso a
  // checagem olha o tamanho antes do prefixo.
  if (national.startsWith('55') && (national.length === 12 || national.length === 13)) {
    return `+${national}`
  }
  if (national.length === 10 || national.length === 11) return `+55${national}`
  if (national.length >= 12) return `+${national}`

  // Curto demais para ser um número com DDD. Devolver os dígitos crus faz o
  // esquema reprovar e pedir o DDD; pôr um "+" na frente transformaria o
  // esquecimento mais comum do Brasil num telefone internacional válido.
  return national
}

/**
 * Soma ponderada de um bloco do CPF, com o peso caindo de `length + 1` até 2.
 * É o mesmo cálculo para os dois dígitos verificadores, só muda o tamanho.
 */
function checkDigit(digits: string, length: number): number {
  let sum = 0
  let weight = length + 1

  for (const char of digits.slice(0, length)) {
    sum += Number(char) * weight
    weight -= 1
  }

  const rest = (sum * 10) % 11
  return rest === 10 ? 0 : rest
}

export function isValidCpf(digits: string): boolean {
  if (!/^[0-9]{11}$/.test(digits)) return false

  // 111.111.111-11 e os outros dez repetidos passam na conta dos dígitos
  // verificadores. São inválidos por convenção da Receita, não por aritmética.
  if (/^([0-9])\1{10}$/.test(digits)) return false

  return digits.slice(9) === `${checkDigit(digits, 9)}${checkDigit(digits, 10)}`
}

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Informe o seu e-mail.')
  .email('Esse e-mail não parece certo. Confira o @ e o final, como .com.')

export const signInSchema = z.object({
  email: emailField,
  // No login não se cobra tamanho mínimo: quem já tem conta antiga pode ter
  // senha mais curta, e reprovar aqui esconderia o problema real.
  password: z.string().min(1, 'Digite a sua senha.'),
})

export const signUpSchema = z.object({
  email: emailField,
  password: z.string().min(8, 'Crie uma senha com pelo menos 8 caracteres.'),
})

export const profileSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .min(3, 'Escreva o seu nome completo.')
      .max(120, 'Nome longo demais. Use o nome como está no documento.'),

    // O campo carrega o nome do formato de saída porque é isso que sai daqui;
    // a entrada é o telefone como a pessoa digitou.
    phoneE164: z
      .string()
      .transform(toE164)
      .refine(
        (value) => E164.test(value),
        'Informe o telefone com DDD, assim: (45) 99999-0000.',
      ),

    email: emailField,

    role: z.enum(['client', 'walker'], {
      errorMap: () => ({
        message: 'Escolha uma opção: contratar serviços ou trabalhar como passeador.',
      }),
    }),

    cpfDigits: z
      .string()
      .transform(onlyDigits)
      .transform((digits) => (digits === '' ? undefined : digits))
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.cpfDigits === undefined) {
      // O trigger assert_walker_has_cpf recusa walker sem CPF. Melhor dizer o
      // motivo aqui do que deixar o banco responder "Walker precisa de CPF".
      if (value.role === 'walker') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cpfDigits'],
          message:
            'Para trabalhar como passeador, informe o seu CPF — é ele que identifica você no recebimento.',
        })
      }
      return
    }

    if (!isValidCpf(value.cpfDigits)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cpfDigits'],
        message: 'CPF inválido. Confira os 11 números.',
      })
    }
  })

export const walkerSchema = z
  .object({
    bio: z
      .string()
      .trim()
      .max(500, 'A apresentação ficou longa. Resuma em até 500 caracteres.')
      .transform((text) => (text === '' ? undefined : text))
      .optional(),

    // Aceita número (seletor, controle deslizante) e texto (teclado numérico),
    // porque a tela pode oferecer qualquer um dos dois.
    radiusM: z.coerce
      .number({ invalid_type_error: 'Informe a distância em metros.' })
      .int('Use um número inteiro de metros.')
      .min(500, 'A distância mínima é 500 metros.')
      .max(20000, 'A distância máxima é 20.000 metros (20 km).'),

    acceptsDog: z.boolean(),
    acceptsCat: z.boolean(),
    acceptsLargeDog: z.boolean(),
  })
  .superRefine((value, ctx) => {
    if (!value.acceptsDog && !value.acceptsCat) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acceptsDog'],
        message: 'Marque cachorro, gato ou os dois. Sem isso você não recebe nenhum pedido.',
      })
    }

    if (value.acceptsLargeDog && !value.acceptsDog) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acceptsLargeDog'],
        message: 'Para aceitar cachorro grande, marque também que você aceita cachorro.',
      })
    }
  })

export type SignInInput = z.infer<typeof signInSchema>
export type SignUpInput = z.infer<typeof signUpSchema>
export type ProfileInput = z.infer<typeof profileSchema>
export type WalkerInput = z.infer<typeof walkerSchema>
