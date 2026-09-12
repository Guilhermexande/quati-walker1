/**
 * Escolher o papel e completar o cadastro.
 *
 * É a tela do estado 'no_profile': a conta existe no Auth e ainda não existe a
 * linha em public.profiles. Sem ela o app não sabe se abre o lado do tutor ou o
 * do passeador — por isso daqui não se sai sem escolher.
 *
 * A escolha é um caminho só de ida, e a tela diz isso antes do toque, não
 * depois: `guard_profile_update` devolve o papel antigo em qualquer update
 * vindo do aplicativo. Prometer "você troca depois" seria mentira.
 *
 * O e-mail é pedido de novo porque o app não lê o endereço do Auth fora de
 * src/api — a tela de cadastro pode mandá-lo como parâmetro, e aí o campo já
 * vem preenchido.
 */
import * as React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'

import { Body, Button, ErrorBanner, Screen, TextField, Title } from '@/components/ui'
import { useCreateProfile } from '@/hooks/useAuth'
import { useTheme, type Theme } from '@/lib/theme'
import { profileSchema } from '@/schemas/profile'

type Papel = 'client' | 'walker'

/**
 * Nenhum valor em reais aqui, de propósito: preço e comissão vivem no banco
 * (ADR decisão 2). Um número escrito na tela envelhece na loja de aplicativos.
 */
const OPCOES: readonly { papel: Papel; titulo: string; resumo: string }[] = [
  {
    papel: 'client',
    titulo: 'Sou tutor',
    resumo:
      'Tenho cão ou gato e quero contratar: alguém passeia com o meu cão ou visita o meu gato em casa, e eu pago por PIX no app.',
  },
  {
    papel: 'walker',
    titulo: 'Quero trabalhar',
    resumo:
      'Recebo pedidos de quem mora perto de mim, escolho quais aceitar e recebo por PIX a cada serviço concluído.',
  },
]

const ROTULO: Record<Papel, string> = {
  client: 'Tutor',
  walker: 'Passeador',
}

export default function EscolhaDePapel(): React.JSX.Element {
  const router = useRouter()
  const s = useStyles()
  const criarPerfil = useCreateProfile()

  const parametros = useLocalSearchParams()
  const emailDaConta = typeof parametros['email'] === 'string' ? parametros['email'] : ''

  const [papel, setPapel] = React.useState<Papel | null>(null)
  const [nome, setNome] = React.useState('')
  const [telefone, setTelefone] = React.useState('')
  const [email, setEmail] = React.useState(() => emailDaConta)
  const [cpf, setCpf] = React.useState('')
  const [erros, setErros] = React.useState<Record<string, string>>({})

  function concluir(escolhido: Papel): void {
    const resultado = profileSchema.safeParse({
      fullName: nome,
      phoneE164: telefone,
      email,
      role: escolhido,
      // Tutor não tem CPF gravado nem por engano: a coluna é única entre contas
      // vivas, e um CPF digitado por curiosidade bloquearia a conta de verdade.
      cpfDigits: escolhido === 'walker' ? cpf : '',
    })

    if (!resultado.success) {
      setErros(errosPorCampo(resultado.error.issues))
      // Sem isto, o erro do envio anterior segue na tela enquanto a pessoa
      // conserta um campo, e parece que o conserto não adiantou.
      criarPerfil.reset()
      return
    }

    setErros({})
    criarPerfil.mutate(resultado.data, {
      onSuccess: (perfil) => {
        // O hook já pôs a sessão em 'ready', e o _layout leva o tutor para o
        // lado dele. O passeador ainda não terminou: sem as preferências não
        // existe linha em walker_profiles, e sem ela nenhum pedido chega.
        if (perfil.role === 'walker') router.replace('/(auth)/walker-setup')
      },
    })
  }

  if (papel === null) {
    return (
      <Screen scroll>
        <Title>Como você vai usar o Quati Walker?</Title>
        <Body dim>A escolha define o aplicativo que você vê daqui em diante.</Body>

        {OPCOES.map((opcao) => (
          <Pressable
            key={opcao.papel}
            onPress={() => setPapel(opcao.papel)}
            accessibilityRole="button"
            accessibilityLabel={`${opcao.titulo}. ${opcao.resumo}`}
            accessibilityHint="Depois de escolher, você preenche os seus dados."
            style={({ pressed }) => [s.cartao, pressed && s.cartaoPressionado]}
          >
            <Text style={s.cartaoTitulo}>{opcao.titulo}</Text>
            <Text style={s.cartaoResumo}>{opcao.resumo}</Text>
          </Pressable>
        ))}

        <View style={s.aviso}>
          <Text style={s.avisoTexto}>
            Uma conta tem um papel só, e ele não muda depois. Se um dia você quiser os dois,
            vai precisar de outra conta, com outro e-mail.
          </Text>
        </View>
      </Screen>
    )
  }

  const ehPasseador = papel === 'walker'

  return (
    <Screen scroll>
      <Title>Seus dados</Title>

      <View style={s.escolha}>
        <Text style={s.escolhaTexto}>Você escolheu: {ROTULO[papel]}</Text>
      </View>

      <Body dim>
        {ehPasseador
          ? 'É com esses dados que o tutor identifica você quando o serviço é aceito.'
          : 'É com esses dados que o passeador entra em contato com você no dia do serviço.'}
      </Body>

      {criarPerfil.error ? <ErrorBanner message={criarPerfil.error.message} /> : null}

      <TextField
        label="Nome completo"
        value={nome}
        onChangeText={setNome}
        placeholder="Como está no seu documento"
        error={erros['fullName']}
      />

      <TextField
        label="Telefone com DDD"
        value={telefone}
        onChangeText={setTelefone}
        placeholder="(45) 99999-0000"
        keyboard="phone-pad"
        error={erros['phoneE164']}
      />

      <TextField
        label="E-mail"
        value={email}
        onChangeText={setEmail}
        placeholder="voce@email.com"
        keyboard="email-address"
        error={erros['email']}
      />

      {ehPasseador ? (
        <>
          <TextField
            label="CPF"
            value={cpf}
            onChangeText={setCpf}
            placeholder="Só os 11 números"
            keyboard="numeric"
            error={erros['cpfDigits']}
          />
          <Body dim>
            O CPF é obrigatório para quem trabalha: é ele que identifica você no recebimento
            do dinheiro. Ele não aparece para os tutores.
          </Body>
        </>
      ) : null}

      <Button
        label="Concluir cadastro"
        onPress={() => concluir(papel)}
        loading={criarPerfil.isPending}
      />

      <Button
        label="Escolher outro papel"
        variant="ghost"
        disabled={criarPerfil.isPending}
        onPress={() => {
          criarPerfil.reset()
          setErros({})
          setCpf('')
          setPapel(null)
        }}
      />
    </Screen>
  )
}

/**
 * A primeira mensagem de cada campo é a que fica. O esquema pode reprovar o
 * mesmo campo duas vezes — "informe o CPF" e um erro derivado dele — e a
 * segunda mensagem só confundiria quem está lendo.
 */
function errosPorCampo(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): Record<string, string> {
  const mapa: Record<string, string> = {}

  for (const issue of issues) {
    const campo = issue.path[0]
    if (typeof campo !== 'string') continue
    mapa[campo] ??= issue.message
  }

  return mapa
}

const sheets = new WeakMap<Theme, ReturnType<typeof createStyles>>()

function useStyles(): ReturnType<typeof createStyles> {
  const theme = useTheme()
  const cached = sheets.get(theme)
  if (cached) return cached
  const created = createStyles(theme)
  sheets.set(theme, created)
  return created
}

function createStyles(t: Theme) {
  const { colors: c, spacing, radius, font } = t

  return StyleSheet.create({
    cartao: {
      backgroundColor: c.surface,
      borderWidth: 2,
      borderColor: c.border,
      borderRadius: radius.lg,
      padding: spacing.lg,
      gap: spacing.xs,
    },
    cartaoPressionado: { backgroundColor: c.primarySoft, borderColor: c.primary },
    cartaoTitulo: {
      color: c.text,
      fontSize: font.size.lg,
      lineHeight: font.line.lg,
      fontWeight: font.weight.bold,
    },
    cartaoResumo: {
      color: c.textDim,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
    },

    aviso: {
      backgroundColor: c.accentSoft,
      borderLeftWidth: 4,
      borderLeftColor: c.accent,
      borderRadius: radius.sm,
      padding: spacing.md,
    },
    avisoTexto: {
      color: c.accent,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
      fontWeight: font.weight.medium,
    },

    escolha: {
      alignSelf: 'flex-start',
      backgroundColor: c.primarySoft,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    escolhaTexto: {
      color: c.text,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
      fontWeight: font.weight.medium,
    },
  })
}
