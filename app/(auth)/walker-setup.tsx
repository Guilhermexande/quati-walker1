/**
 * Preferências de atendimento do passeador — o último passo do cadastro dele.
 *
 * Enquanto não existir linha em walker_profiles, nenhum pedido chega: é esta
 * linha que diz até onde a pessoa atende e quais animais aceita. Por isso a
 * tela vem logo depois da escolha de papel, e não numa aba de configuração.
 *
 * O raio é uma lista de opções, não um controle deslizante: quatro distâncias
 * redondas são mais fáceis de decidir do que um número qualquer entre 500 m e
 * 20 km, e cada uma vem com o que ela significa em Foz.
 */
import * as React from 'react'
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native'
import { useRouter } from 'expo-router'

import { Body, Button, ErrorBanner, Screen, Title } from '@/components/ui'
import { useSaveWalkerProfile } from '@/hooks/useAuth'
import { useTheme, type Theme } from '@/lib/theme'
import { walkerSchema } from '@/schemas/profile'
import { useSessionStore } from '@/stores/session'

const RAIOS: readonly { metros: number; rotulo: string; detalhe: string }[] = [
  { metros: 1000, rotulo: '1 km', detalhe: 'Praticamente só o seu bairro. Dá para ir a pé.' },
  { metros: 3000, rotulo: '3 km', detalhe: 'O seu bairro e os vizinhos.' },
  { metros: 5000, rotulo: '5 km', detalhe: 'Boa parte da cidade. Mais pedidos, mais deslocamento.' },
  { metros: 10000, rotulo: '10 km', detalhe: 'Quase Foz inteira. Conte o tempo e o custo de chegar.' },
]

export default function PreferenciasDoPasseador(): React.JSX.Element {
  const router = useRouter()
  const s = useStyles()

  const papel = useSessionStore((estado) => estado.role)
  const salvar = useSaveWalkerProfile()

  // 5 km é o mesmo padrão da coluna radius_m: quem não mexer em nada fica com o
  // que o banco já consideraria razoável.
  const [raio, setRaio] = React.useState(5000)
  const [aceitaCao, setAceitaCao] = React.useState(true)
  const [aceitaGato, setAceitaGato] = React.useState(false)
  const [aceitaCaoGrande, setAceitaCaoGrande] = React.useState(false)
  const [erroDasEspecies, setErroDasEspecies] = React.useState<string | undefined>(undefined)

  function trocarCao(aceita: boolean): void {
    setAceitaCao(aceita)
    // Cachorro grande é um subconjunto de cachorro. Deixar a marca de grande
    // sobrando reprovaria no esquema por um motivo que ninguém enxerga na tela.
    if (!aceita) setAceitaCaoGrande(false)
    setErroDasEspecies(undefined)
  }

  function guardar(): void {
    const resultado = walkerSchema.safeParse({
      radiusM: raio,
      acceptsDog: aceitaCao,
      acceptsCat: aceitaGato,
      acceptsLargeDog: aceitaCaoGrande,
    })

    if (!resultado.success) {
      const primeiro = resultado.error.issues[0]
      setErroDasEspecies(primeiro?.message ?? 'Confira as opções marcadas.')
      salvar.reset()
      return
    }

    setErroDasEspecies(undefined)
    salvar.mutate(resultado.data)
  }

  if (papel !== 'walker') {
    return (
      <Screen>
        <Title>Esta parte é de quem vai trabalhar</Title>
        <Body>
          Aqui o passeador diz até onde atende e quais animais aceita. Quem contrata passeio
          ou visita não precisa preencher nada disso.
        </Body>
        <Body dim>Termine o seu cadastro e o app leva você para o lugar certo.</Body>
        {router.canGoBack() ? (
          <Button label="Voltar" variant="ghost" onPress={() => router.back()} />
        ) : null}
      </Screen>
    )
  }

  if (salvar.isSuccess) {
    return (
      <Screen scroll>
        <Title>Pronto, está tudo salvo</Title>
        <Body>
          Você vai receber só os pedidos que combinam com o que marcou aqui, dentro da
          distância que escolheu. Dá para mudar isso quando quiser.
        </Body>

        {/* A conexão com o Mercado Pago é o Épico 5. Não existe tela para isso
            hoje, e inventar um botão que não leva a lugar nenhum seria pior do
            que dizer a verdade: sem a conta conectada, o pedido não chega. */}
        <View style={s.aviso}>
          <Text style={s.avisoTitulo}>Ainda falta uma coisa para você receber pedidos</Text>
          <Text style={s.avisoTexto}>
            O dinheiro de cada serviço cai direto na sua conta do Mercado Pago, e ela ainda
            não está ligada ao aplicativo. Enquanto isso não acontecer, os pedidos dos
            tutores não aparecem para você.
          </Text>
          <Text style={s.avisoTexto}>
            Essa parte do app ainda está sendo construída. Assim que ficar pronta, a gente
            avisa você por aqui.
          </Text>
        </View>

        <Button label="Continuar" onPress={() => router.replace('/(walker)')} />
      </Screen>
    )
  }

  return (
    <Screen scroll>
      <Title>Onde e com quem você atende</Title>
      <Body dim>
        São estas respostas que decidem quais pedidos chegam até você. Nada disso aparece
        para o tutor antes de você aceitar um serviço.
      </Body>

      {salvar.error ? <ErrorBanner message={salvar.error.message} /> : null}

      <Text style={s.grupoTitulo} accessibilityRole="header">
        Até que distância você vai
      </Text>
      <Text style={s.grupoAjuda}>Contando a partir de onde você estiver no momento do pedido.</Text>

      <View style={s.grupo} accessibilityRole="radiogroup">
        {RAIOS.map((opcao) => {
          const escolhido = opcao.metros === raio

          return (
            <Pressable
              key={opcao.metros}
              onPress={() => setRaio(opcao.metros)}
              accessibilityRole="radio"
              accessibilityState={{ checked: escolhido }}
              accessibilityLabel={`${opcao.rotulo}. ${opcao.detalhe}`}
              style={({ pressed }) => [
                s.linha,
                escolhido && s.linhaEscolhida,
                pressed && s.linhaPressionada,
              ]}
            >
              {/* A marca é um desenho, não só uma cor: quem não distingue verde
                  de cinza continua vendo qual está escolhido. */}
              <View style={[s.marca, escolhido && s.marcaEscolhida]}>
                {escolhido ? <View style={s.marcaMiolo} /> : null}
              </View>

              <View style={s.linhaTexto}>
                <Text style={s.linhaTitulo}>{opcao.rotulo}</Text>
                <Text style={s.linhaDetalhe}>{opcao.detalhe}</Text>
              </View>
            </Pressable>
          )
        })}
      </View>

      <Text style={s.grupoTitulo} accessibilityRole="header">
        Quais animais você aceita
      </Text>

      <Chave
        titulo="Cachorro — passeio"
        detalhe="Você busca o cão na casa do tutor e passeia com ele na rua."
        valor={aceitaCao}
        aoTrocar={trocarCao}
      />

      <Chave
        titulo="Gato — visita em casa"
        detalhe="Gato não passeia. Aqui você vai até a casa do tutor: comida, água, caixa de areia e um tempo de companhia. O animal não sai."
        valor={aceitaGato}
        aoTrocar={(aceita) => {
          setAceitaGato(aceita)
          setErroDasEspecies(undefined)
        }}
      />

      <Chave
        titulo="Cachorro de porte grande"
        detalhe="Acima de 25 kg costuma puxar a guia com força. Marque só se você tem prática. Vale apenas para quem aceita cachorro."
        valor={aceitaCaoGrande}
        bloqueado={!aceitaCao}
        aoTrocar={setAceitaCaoGrande}
      />

      {/* Espaço fixo: a mensagem aparece sem empurrar o botão para baixo no
          instante em que o dedo já está indo nele. */}
      <View style={s.erroVaga}>
        {erroDasEspecies !== undefined ? (
          <Text style={s.erroTexto} accessibilityLiveRegion="polite">
            {erroDasEspecies}
          </Text>
        ) : null}
      </View>

      <Button label="Salvar e continuar" onPress={guardar} loading={salvar.isPending} />
    </Screen>
  )
}

/**
 * Linha com chave liga/desliga. O toque vale na linha inteira — o quadradinho
 * da chave tem menos de 44pt de altura, e o passeador mexe no app na rua.
 */
function Chave({
  titulo,
  detalhe,
  valor,
  aoTrocar,
  bloqueado = false,
}: {
  titulo: string
  detalhe: string
  valor: boolean
  aoTrocar: (valor: boolean) => void
  bloqueado?: boolean
}): React.JSX.Element {
  const s = useStyles()
  const theme = useTheme()

  return (
    <Pressable
      onPress={() => aoTrocar(!valor)}
      disabled={bloqueado}
      accessibilityRole="switch"
      accessibilityState={{ checked: valor, disabled: bloqueado }}
      accessibilityLabel={titulo}
      accessibilityHint={detalhe}
      style={({ pressed }) => [s.linha, pressed && s.linhaPressionada]}
    >
      <View style={s.linhaTexto}>
        <Text style={[s.linhaTitulo, bloqueado && s.textoBloqueado]}>{titulo}</Text>
        <Text style={s.linhaDetalhe}>{detalhe}</Text>
      </View>

      {/* A chave é só o desenho do estado: quem recebe o toque e quem fala com
          o leitor de tela é a linha, para não haver dois alvos dizendo o mesmo. */}
      <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no">
        <Switch
          value={valor}
          onValueChange={aoTrocar}
          disabled={bloqueado}
          trackColor={{ false: theme.colors.surfaceAlt, true: theme.colors.primary }}
          // `textOnPrimary` sobre `primary` é o par que o tema garante legível;
          // desligada, o cinza do texto de apoio é o que aparece no escuro.
          thumbColor={valor ? theme.colors.textOnPrimary : theme.colors.textDim}
          ios_backgroundColor={theme.colors.surfaceAlt}
        />
      </View>
    </Pressable>
  )
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
    grupoTitulo: {
      color: c.text,
      fontSize: font.size.md,
      lineHeight: font.line.md,
      fontWeight: font.weight.bold,
      marginTop: spacing.sm,
    },
    grupoAjuda: {
      color: c.textDim,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
    },

    grupo: { gap: spacing.sm },

    linha: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      // A linha inteira é o alvo do toque; 60pt passa folgado dos 44 mínimos.
      minHeight: 60,
      backgroundColor: c.surface,
      borderWidth: 2,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    linhaEscolhida: { borderColor: c.primary, backgroundColor: c.primarySoft },
    linhaPressionada: { borderColor: c.focus },
    linhaTexto: { flex: 1, gap: 2 },
    linhaTitulo: {
      color: c.text,
      fontSize: font.size.md,
      lineHeight: font.line.md,
      fontWeight: font.weight.medium,
    },
    linhaDetalhe: {
      color: c.textDim,
      fontSize: font.size.xs,
      lineHeight: font.line.xs,
    },
    textoBloqueado: { color: c.textDim },

    marca: {
      width: 24,
      height: 24,
      borderRadius: radius.pill,
      borderWidth: 2,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    marcaEscolhida: { borderColor: c.primary },
    marcaMiolo: {
      width: 12,
      height: 12,
      borderRadius: radius.pill,
      backgroundColor: c.primary,
    },

    erroVaga: { minHeight: font.line.sm },
    erroTexto: {
      color: c.danger,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
      fontWeight: font.weight.medium,
    },

    aviso: {
      backgroundColor: c.accentSoft,
      borderLeftWidth: 4,
      borderLeftColor: c.accent,
      borderRadius: radius.sm,
      padding: spacing.md,
      gap: spacing.sm,
    },
    avisoTitulo: {
      color: c.accent,
      fontSize: font.size.md,
      lineHeight: font.line.md,
      fontWeight: font.weight.bold,
    },
    avisoTexto: {
      color: c.accent,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
    },
  })
}
