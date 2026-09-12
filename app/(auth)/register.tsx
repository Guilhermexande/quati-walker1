/**
 * Criar conta: e-mail, senha e a repetição da senha.
 *
 * Duas decisões de tela que valem explicação:
 *
 * 1. A regra da senha aparece ANTES do campo, e vai marcando sozinha enquanto a
 *    pessoa digita. Regra que só aparece depois do erro transforma o cadastro
 *    num jogo de adivinhação — a pessoa tenta, erra, tenta de novo, desiste.
 *
 * 2. A confirmação da senha não está no signUpSchema, e está certo: ela não é
 *    dado que vai para o servidor, é conferência de digitação. O esquema de lá
 *    é estendido aqui em vez de alterado lá, para que a regra do cadastro
 *    (mínimo de 8) continue existindo num lugar só.
 *
 * Terminado o cadastro, quem manda na navegação é o _layout da raiz: o useSignUp
 * põe a sessão em 'no_profile' e de lá a pessoa cai na escolha de papel. Esta
 * tela não empurra rota nenhuma depois do sucesso.
 */
import * as React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Controller, useForm, useWatch, type Control } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'

import { Body, Button, ErrorBanner, Screen, TextField, Title } from '@/components/ui'
import { useSignUp } from '@/hooks/useAuth'
import { useTheme, type Theme } from '@/lib/theme'
import { signUpSchema } from '@/schemas/profile'

/**
 * Só para o texto da regra na tela. Quem reprova a senha curta continua sendo o
 * signUpSchema — este número existe para o aviso dizer o mesmo que a validação.
 */
const MINIMO_DA_SENHA = 8

const cadastroSchema = signUpSchema
  .extend({
    passwordConfirm: z.string().min(1, 'Repita a senha para confirmar.'),
  })
  .refine((valor) => valor.password === valor.passwordConfirm, {
    // Sem o `path` o erro sobraria solto no formulário, sem campo para pousar.
    path: ['passwordConfirm'],
    message: 'As duas senhas estão diferentes. Digite a mesma nas duas linhas.',
  })

type CadastroInput = z.infer<typeof cadastroSchema>

export default function RegisterScreen(): React.JSX.Element {
  const router = useRouter()
  const criarConta = useSignUp()
  const s = useStyles()

  const { control, handleSubmit } = useForm<CadastroInput>({
    resolver: zodResolver(cadastroSchema),
    defaultValues: { email: '', password: '', passwordConfirm: '' },
  })

  const enviar = handleSubmit((dados) => {
    criarConta.mutate({ email: dados.email, password: dados.password })
  })

  const recado = mensagemDoErro(criarConta.error)

  const voltarParaEntrar = () => {
    // Cadastro pode ser a primeira tela da pilha — quem chega por link do
    // convite não passou pelo login. Sem esta checagem, `back()` não faz nada e
    // o botão vira enfeite.
    if (router.canGoBack()) {
      router.back()
      return
    }
    router.replace('/login')
  }

  return (
    <Screen scroll>
      {/* O KeyboardAvoidingView (com behavior por plataforma) já vem do Screen.
          Este formulário é o mais alto do fluxo de entrada: é por isso que ele
          rola, e não porque o conteúdo é longo. Com o teclado aberto num
          aparelho pequeno, a confirmação da senha precisa alcançar a tela. */}
      <View style={s.cabecalho}>
        <Title>Criar sua conta</Title>
        <Body dim>
          É este e-mail e esta senha que você vai usar toda vez que abrir o Quati Walker.
        </Body>
      </View>

      <View style={s.formulario}>
        {recado === null ? null : <ErrorBanner message={recado} />}

        <Controller
          control={control}
          name="email"
          render={({ field, fieldState }) => (
            <TextField
              label="E-mail"
              value={field.value}
              onChangeText={field.onChange}
              placeholder="voce@exemplo.com"
              keyboard="email-address"
              error={fieldState.error?.message}
            />
          )}
        />

        <RegraDaSenha control={control} />

        <Controller
          control={control}
          name="password"
          render={({ field, fieldState }) => (
            <TextField
              label="Senha"
              value={field.value}
              onChangeText={field.onChange}
              placeholder="Crie uma senha"
              secure
              error={fieldState.error?.message}
            />
          )}
        />

        <Controller
          control={control}
          name="passwordConfirm"
          render={({ field, fieldState }) => (
            <TextField
              label="Repita a senha"
              value={field.value}
              onChangeText={field.onChange}
              placeholder="A mesma senha de cima"
              secure
              error={fieldState.error?.message}
            />
          )}
        />

        <Button
          label="Criar conta"
          onPress={() => void enviar()}
          loading={criarConta.isPending}
        />

        <Body dim>
          No passo seguinte você diz se quer contratar serviços para o seu animal ou
          trabalhar como passeador.
        </Body>
      </View>

      <View style={s.espaco} />

      <View style={s.rodape}>
        <Body dim>Já tem conta?</Body>
        <Button
          label="Entrar com a minha conta"
          variant="ghost"
          onPress={voltarParaEntrar}
          disabled={criarConta.isPending}
        />
      </View>
    </Screen>
  )
}

/**
 * A regra da senha, visível antes de a pessoa errar e marcada em tempo real.
 *
 * Observa o campo pelo `useWatch` em vez de receber o valor por prop: assim cada
 * tecla digitada re-renderiza só este bloco, e não o formulário inteiro.
 */
function RegraDaSenha({ control }: { control: Control<CadastroInput> }): React.JSX.Element {
  const s = useStyles()
  const senha = useWatch({ control, name: 'password' }) ?? ''
  const atende = senha.length >= MINIMO_DA_SENHA

  const rotulo = `Pelo menos ${MINIMO_DA_SENHA} caracteres`

  return (
    <View style={s.regra}>
      <Text style={s.regraTitulo}>A sua senha precisa de:</Text>

      {/* O sinal não é só a cor: o marcador troca de desenho (• vira ✓). Quem
          não distingue verde de cinza continua vendo a diferença. */}
      <View
        style={s.regraLinha}
        accessible
        accessibilityLabel={`${rotulo}. ${atende ? 'Sua senha já atende.' : 'Ainda falta.'}`}
        accessibilityLiveRegion="polite"
      >
        <Text style={[s.regraMarcador, atende && s.regraMarcadorOk]}>{atende ? '✓' : '•'}</Text>
        <Text style={[s.regraTexto, atende && s.regraTextoOk]}>{rotulo}</Text>
      </View>

      <Text style={s.regraDica}>
        Vale qualquer combinação de letras, números e símbolos. Evite o seu nome e a sua
        data de nascimento.
      </Text>
    </View>
  )
}

function mensagemDoErro(error: Error | null): string | null {
  if (error === null) return null

  const texto = error.message.trim()
  if (texto === '') {
    return 'Não foi possível criar a conta agora. Tente de novo em alguns minutos.'
  }
  return texto
}

function useStyles(): ReturnType<typeof createStyles> {
  const theme = useTheme()
  return React.useMemo(() => createStyles(theme), [theme])
}

function createStyles(t: Theme) {
  const { colors: c, spacing, radius, font } = t

  return StyleSheet.create({
    cabecalho: { paddingTop: spacing.lg, gap: spacing.sm },
    formulario: { gap: spacing.md, paddingTop: spacing.md },
    espaco: { flex: 1, minHeight: spacing.lg },
    rodape: { gap: spacing.xs, alignItems: 'stretch' },

    regra: {
      backgroundColor: c.surfaceAlt,
      borderRadius: radius.md,
      padding: spacing.md,
      gap: spacing.xs,
    },
    regraTitulo: {
      color: c.text,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
      fontWeight: font.weight.medium,
    },
    regraLinha: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    regraMarcador: {
      // Largura fixa para o texto não dançar quando o • vira ✓.
      width: 16,
      textAlign: 'center',
      color: c.textDim,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
      fontWeight: font.weight.bold,
    },
    regraMarcadorOk: { color: c.primary },
    regraTexto: {
      flex: 1,
      color: c.textDim,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
    },
    regraTextoOk: { color: c.text, fontWeight: font.weight.medium },
    regraDica: {
      color: c.textDim,
      fontSize: font.size.xs,
      lineHeight: font.line.xs,
    },
  })
}
