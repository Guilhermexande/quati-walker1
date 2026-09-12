/**
 * A primeira tela que alguém vê do Quati Walker.
 *
 * Ela tem duas tarefas e a ordem importa: primeiro dizer que app é este e para
 * que ele serve, depois pedir e-mail e senha. Quem chega aqui pode ter baixado
 * o app por indicação de um vizinho e não lembrar direito o que ele faz — se a
 * tela abre num par de campos vazios, a pessoa desinstala.
 *
 * A tela não navega depois de entrar. Quem entrou vira sessão (useSignIn põe o
 * papel na store) e é o _layout da raiz que decide para onde ir — tutor, walker
 * ou escolha de papel. Empurrar rota daqui criaria uma segunda autoridade sobre
 * a navegação, e as duas brigariam no primeiro caso de conta sem perfil.
 */
import * as React from 'react'
import { StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'

import { Body, Button, ErrorBanner, Screen, TextField, Title } from '@/components/ui'
import { useSignIn } from '@/hooks/useAuth'
import { useTheme, type Theme } from '@/lib/theme'
import { signInSchema, type SignInInput } from '@/schemas/profile'

export default function LoginScreen(): React.JSX.Element {
  const router = useRouter()
  const entrar = useSignIn()
  const s = useStyles()

  const { control, handleSubmit } = useForm<SignInInput>({
    resolver: zodResolver(signInSchema),
    defaultValues: { email: '', password: '' },
    // Fica no padrão de propósito: valida no envio e, a partir daí, a cada
    // tecla. O TextField não expõe onBlur, então 'onTouched' não teria efeito
    // nenhum — e acusar erro antes de a pessoa terminar de digitar o e-mail é
    // exatamente o que faz formulário parecer hostil.
  })

  const enviar = handleSubmit((dados) => {
    entrar.mutate({ email: dados.email, password: dados.password })
  })

  // A mensagem já chega pronta e em português de src/api/auth.ts — inclusive a
  // de credencial errada, que lá vira "E-mail ou senha não conferem". Reescrever
  // aqui daria duas versões do mesmo texto, e uma delas ficaria para trás.
  const recado = mensagemDoErro(entrar.error)

  return (
    <Screen scroll>
      {/* O Screen já embrulha tudo num KeyboardAvoidingView com behavior por
          plataforma ('padding' no iOS, nada no Android, que redimensiona a
          janela sozinho). Repetir aqui empilharia dois ajustes no iOS e
          empurraria o formulário para fora da tela. */}
      <View style={s.cabecalho}>
        <Pata />
        <Title>Quati Walker</Title>
        <Body dim>
          Passeio para cachorro e visita em casa para gato, com passeador aqui de Foz do
          Iguaçu.
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

        <Controller
          control={control}
          name="password"
          render={({ field, fieldState }) => (
            <TextField
              label="Senha"
              value={field.value}
              onChangeText={field.onChange}
              placeholder="Sua senha"
              secure
              error={fieldState.error?.message}
            />
          )}
        />

        <Button label="Entrar" onPress={() => void enviar()} loading={entrar.isPending} />
      </View>

      {/* Empurra o convite de cadastro para o rodapé em tela alta e vira nada em
          tela baixa — com o teclado aberto não sobra espaço, e aí ele encolhe em
          vez de brigar pelo lugar do botão. */}
      <View style={s.espaco} />

      <View style={s.rodape}>
        <Body dim>Ainda não tem conta no Quati Walker?</Body>
        <Button
          label="Criar minha conta"
          variant="ghost"
          onPress={() => router.push('/register')}
          disabled={entrar.isPending}
        />
      </View>
    </Screen>
  )
}

/**
 * A marca: uma patinha desenhada com Views.
 *
 * São cinco retângulos arredondados, não uma imagem — assim ela acompanha a cor
 * do tema claro e escuro sem precisar de dois arquivos, e não pesa no bundle.
 */
function Pata(): React.JSX.Element {
  const s = useStyles()

  return (
    <View
      style={s.pataFundo}
      accessible
      accessibilityRole="image"
      accessibilityLabel="Símbolo do Quati Walker: uma pata de animal"
    >
      <View style={s.pataArea}>
        <View style={[s.pataDedo, s.pataDedo1]} />
        <View style={[s.pataDedo, s.pataDedo2]} />
        <View style={[s.pataDedo, s.pataDedo3]} />
        <View style={[s.pataDedo, s.pataDedo4]} />
        <View style={s.pataAlmofada} />
      </View>
    </View>
  )
}

/**
 * O que mostrar na faixa vermelha. Devolve null quando não houve falha.
 *
 * O fallback existe para o erro que não é AppError — uma exceção de biblioteca,
 * um `Error` sem texto. Ninguém merece uma faixa vermelha vazia.
 */
function mensagemDoErro(error: Error | null): string | null {
  if (error === null) return null

  const texto = error.message.trim()
  if (texto === '') return 'Não foi possível entrar agora. Tente de novo em alguns minutos.'
  return texto
}

function useStyles(): ReturnType<typeof createStyles> {
  const theme = useTheme()
  return React.useMemo(() => createStyles(theme), [theme])
}

function createStyles(t: Theme) {
  const { colors: c, spacing, radius } = t

  return StyleSheet.create({
    cabecalho: { paddingTop: spacing.xl, gap: spacing.md },
    formulario: { gap: spacing.md, paddingTop: spacing.lg },
    espaco: { flex: 1, minHeight: spacing.xl },
    rodape: { gap: spacing.xs, alignItems: 'stretch' },

    pataFundo: {
      width: 76,
      height: 76,
      borderRadius: radius.lg,
      backgroundColor: c.primarySoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // Os dedos e a almofada são posicionados dentro desta caixa; as coordenadas
    // abaixo só fazem sentido em relação a estes 48x40.
    pataArea: { width: 48, height: 40 },
    pataDedo: {
      position: 'absolute',
      width: 11,
      height: 14,
      borderRadius: 6,
      backgroundColor: c.primary,
    },
    pataDedo1: { left: 0, top: 7 },
    pataDedo2: { left: 12, top: 0 },
    pataDedo3: { left: 25, top: 0 },
    pataDedo4: { left: 37, top: 7 },
    pataAlmofada: {
      position: 'absolute',
      left: 8,
      top: 20,
      width: 32,
      height: 20,
      borderRadius: 11,
      backgroundColor: c.primary,
    },
  })
}
