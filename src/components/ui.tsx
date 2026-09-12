/**
 * Os blocos de construção de TODA tela do app.
 *
 * Sem biblioteca de UI: StyleSheet puro. São sete componentes — o custo de
 * mantê-los é menor que o custo de brigar com o tema de uma biblioteca.
 *
 * Três regras que valem para todos eles:
 *   1. Nada de área de toque abaixo de 44pt. Walker mexe no app andando.
 *   2. Nada muda de tamanho ao mudar de estado. Botão que carrega não encolhe,
 *      campo que erra não empurra o formulário para baixo.
 *   3. Cor nunca é o único sinal. Erro tem texto, foco tem espessura, botão
 *      bloqueado tem fundo diferente.
 */
import * as React from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardTypeOptions,
  type TextInputProps,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useTheme, type Theme } from '@/lib/theme'

/** Mínimo de área de toque em pontos — iOS HIG e Material dizem o mesmo número. */
const TOUCH_MIN = 44

/**
 * Tela: fundo, respiro nas bordas e o teclado que não cobre o campo.
 *
 * `scroll` quando o conteúdo pode passar da altura da tela — formulário longo,
 * lista de pedidos. Sem `scroll` a tela fica fixa, e aí o conteúdo precisa
 * caber. Os filhos já vêm espaçados entre si; telas não colocam margem à mão.
 */
export function Screen({
  children,
  scroll = false,
}: {
  children: React.ReactNode
  scroll?: boolean
}): React.JSX.Element {
  const s = useStyles()

  return (
    <SafeAreaView style={s.screen} edges={['top', 'bottom', 'left', 'right']}>
      <KeyboardAvoidingView
        style={s.fill}
        // No Android o próprio sistema redimensiona a janela; forçar aqui
        // briga com o comportamento nativo e corta o campo de baixo.
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {scroll ? (
          <ScrollView
            style={s.fill}
            contentContainerStyle={s.screenScrollContent}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            alwaysBounceVertical={false}
          >
            {children}
          </ScrollView>
        ) : (
          <View style={s.screenContent}>{children}</View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  )
}

/** Título da tela. Um por tela — é o cabeçalho que o leitor de tela anuncia. */
export function Title({ children }: { children: React.ReactNode }): React.JSX.Element {
  const s = useStyles()
  return (
    <Text style={s.title} accessibilityRole="header">
      {children}
    </Text>
  )
}

/** Texto corrido. `dim` para explicação de apoio, nunca para informação essencial. */
export function Body({
  children,
  dim = false,
}: {
  children: React.ReactNode
  dim?: boolean
}): React.JSX.Element {
  const s = useStyles()
  return <Text style={[s.body, dim && s.bodyDim]}>{children}</Text>
}

export function Button({
  label,
  onPress,
  loading = false,
  disabled = false,
  variant = 'primary',
}: {
  label: string
  onPress: () => void
  loading?: boolean
  disabled?: boolean
  variant?: 'primary' | 'ghost'
}): React.JSX.Element {
  const theme = useTheme()
  const s = useStyles()

  const blocked = disabled || loading
  // Carregando continua com a cor da ação: o toque já foi aceito, o botão não
  // virou outra coisa. Só o desabilitado de verdade fica apagado.
  const muted = disabled && !loading
  const primary = variant === 'primary'

  const spinnerColor = primary && !muted ? theme.colors.textOnPrimary : theme.colors.primary

  return (
    <Pressable
      onPress={onPress}
      disabled={blocked}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: blocked, busy: loading }}
      style={({ pressed }) => [
        s.button,
        primary ? s.buttonPrimary : s.buttonGhost,
        pressed && (primary ? s.buttonPrimaryPressed : s.buttonGhostPressed),
        muted && s.buttonMuted,
      ]}
    >
      {/* O rótulo fica invisível, não é removido: a largura e a altura do botão
          são as mesmas com e sem carregamento, então nada salta na tela. */}
      <Text
        style={[
          s.buttonLabel,
          muted ? s.buttonLabelMuted : primary ? s.buttonLabelPrimary : s.buttonLabelGhost,
          loading && s.buttonLabelLoading,
        ]}
      >
        {label}
      </Text>
      {loading ? (
        <View style={[StyleSheet.absoluteFillObject, s.buttonSpinner]} pointerEvents="none">
          <ActivityIndicator color={spinnerColor} />
        </View>
      ) : null}
    </Pressable>
  )
}

type KeyboardKind = 'default' | 'email-address' | 'phone-pad' | 'numeric'

const KEYBOARD_TYPE: Record<KeyboardKind, KeyboardTypeOptions> = {
  default: 'default',
  'email-address': 'email-address',
  'phone-pad': 'phone-pad',
  // `number-pad` só tem dígitos. CPF e valores não precisam de vírgula nem sinal.
  numeric: 'number-pad',
}

export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  error,
  secure = false,
  keyboard = 'default',
}: {
  label: string
  value: string
  onChangeText: (v: string) => void
  placeholder?: string
  error?: string
  secure?: boolean
  keyboard?: KeyboardKind
}): React.JSX.Element {
  const theme = useTheme()
  const s = useStyles()

  const [focused, setFocused] = React.useState(false)
  const [revealed, setRevealed] = React.useState(false)

  const hasError = error !== undefined && error.trim().length > 0

  const autoComplete: TextInputProps['autoComplete'] = secure
    ? 'password'
    : keyboard === 'email-address'
      ? 'email'
      : keyboard === 'phone-pad'
        ? 'tel'
        : 'off'

  const textContentType: TextInputProps['textContentType'] = secure
    ? 'password'
    : keyboard === 'email-address'
      ? 'emailAddress'
      : keyboard === 'phone-pad'
        ? 'telephoneNumber'
        : 'none'

  return (
    <View style={s.field}>
      <Text
        style={[s.fieldLabel, hasError ? s.fieldLabelError : focused && s.fieldLabelFocused]}
        // O rótulo pertence ao campo; quem usa leitor de tela ouve os dois juntos
        // pelo accessibilityLabel do TextInput, e não precisa ouvir duas vezes.
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        {label}
      </Text>

      {/* A borda tem 2pt em todos os estados e só troca de cor. Espessura que
          cresce no foco empurra o conteúdo de lado — aqui não acontece. */}
      <View style={[s.fieldBox, hasError ? s.fieldBoxError : focused && s.fieldBoxFocused]}>
        <TextInput
          style={s.fieldInput}
          value={value}
          onChangeText={onChangeText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
          placeholderTextColor={theme.colors.textDim}
          selectionColor={theme.colors.primary}
          secureTextEntry={secure && !revealed}
          keyboardType={KEYBOARD_TYPE[keyboard]}
          autoCapitalize={keyboard === 'default' && !secure ? 'sentences' : 'none'}
          autoCorrect={keyboard === 'default' && !secure}
          autoComplete={autoComplete}
          textContentType={textContentType}
          accessibilityLabel={label}
          accessibilityHint={hasError ? error : undefined}
        />

        {secure ? (
          <Pressable
            onPress={() => setRevealed((r) => !r)}
            style={s.fieldReveal}
            accessibilityRole="button"
            accessibilityLabel={revealed ? 'Ocultar a senha' : 'Mostrar a senha'}
          >
            <Text style={s.fieldRevealText}>{revealed ? 'Ocultar' : 'Mostrar'}</Text>
          </Pressable>
        ) : null}
      </View>

      {/* A linha do erro existe sempre, vazia ou não. Formulário que cresce a
          cada erro faz o dedo acertar o botão errado. */}
      <View style={s.fieldErrorSlot}>
        {hasError ? (
          <Text style={s.fieldErrorText} accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}
      </View>
    </View>
  )
}

/**
 * Erro que vale para a tela inteira — o que veio do servidor, não do campo.
 * A mensagem chega pronta (ver `toAppError` em src/api/client.ts): já diz o que
 * houve e o que fazer. Aqui não se reescreve texto de erro.
 */
export function ErrorBanner({ message }: { message: string }): React.JSX.Element {
  const s = useStyles()
  return (
    <View style={s.banner} accessibilityRole="alert" accessibilityLiveRegion="assertive">
      <Text style={s.bannerText}>{message}</Text>
    </View>
  )
}

/** Espera. Ocupa a área disponível e diz, por escrito, que está carregando. */
export function Loading(): React.JSX.Element {
  const theme = useTheme()
  const s = useStyles()
  return (
    <View style={s.loading} accessibilityRole="progressbar" accessibilityLabel="Carregando">
      <ActivityIndicator size="large" color={theme.colors.primary} />
      <Text style={s.loadingText}>Carregando…</Text>
    </View>
  )
}

/**
 * Existem dois temas e eles são constantes de módulo, então existem no máximo
 * duas folhas de estilo em todo o app — por isso o cache por tema, e não um
 * `useMemo` que recria a folha em cada componente montado.
 */
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
    fill: { flex: 1 },

    screen: { flex: 1, backgroundColor: c.bg },
    screenContent: { flex: 1, padding: spacing.lg, gap: spacing.md },
    screenScrollContent: { flexGrow: 1, padding: spacing.lg, gap: spacing.md },

    title: {
      color: c.text,
      fontSize: font.size.xl,
      lineHeight: font.line.xl,
      fontWeight: font.weight.bold,
      letterSpacing: -0.4,
    },

    body: {
      color: c.text,
      fontSize: font.size.md,
      lineHeight: font.line.md,
      fontWeight: font.weight.regular,
    },
    bodyDim: { color: c.textDim },

    button: {
      minHeight: 48,
      borderRadius: radius.md,
      borderWidth: 2,
      borderColor: 'transparent',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonPrimary: { backgroundColor: c.primary, borderColor: c.primary },
    buttonPrimaryPressed: { backgroundColor: c.primaryPressed, borderColor: c.primaryPressed },
    buttonGhost: { backgroundColor: 'transparent' },
    buttonGhostPressed: { backgroundColor: c.primarySoft, borderColor: c.primarySoft },
    // Desabilitado muda de fundo em vez de baixar opacidade: opacidade derruba
    // o contraste do rótulo e ele deixa de ser legível.
    buttonMuted: { backgroundColor: c.surfaceAlt, borderColor: c.surfaceAlt },
    buttonLabel: {
      fontSize: font.size.md,
      lineHeight: font.line.md,
      fontWeight: font.weight.bold,
      textAlign: 'center',
    },
    buttonLabelPrimary: { color: c.textOnPrimary },
    buttonLabelGhost: { color: c.primary },
    buttonLabelMuted: { color: c.textDim },
    buttonLabelLoading: { opacity: 0 },
    buttonSpinner: { alignItems: 'center', justifyContent: 'center' },

    field: { gap: spacing.xs },
    fieldLabel: {
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
      fontWeight: font.weight.medium,
      color: c.textDim,
    },
    fieldLabelFocused: { color: c.focus },
    fieldLabelError: { color: c.danger },
    fieldBox: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: TOUCH_MIN + 8,
      borderWidth: 2,
      borderColor: c.border,
      borderRadius: radius.md,
      backgroundColor: c.surface,
      paddingLeft: spacing.md,
    },
    fieldBoxFocused: { borderColor: c.focus },
    fieldBoxError: { borderColor: c.danger },
    fieldInput: {
      flex: 1,
      color: c.text,
      fontSize: font.size.md,
      paddingVertical: spacing.md,
      paddingRight: spacing.md,
      // Android alinha o texto do campo ao topo por padrão.
      textAlignVertical: 'center',
    },
    fieldReveal: {
      minWidth: TOUCH_MIN,
      minHeight: TOUCH_MIN,
      paddingHorizontal: spacing.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    fieldRevealText: {
      fontSize: font.size.sm,
      fontWeight: font.weight.medium,
      color: c.primary,
    },
    fieldErrorSlot: { minHeight: font.line.xs },
    fieldErrorText: {
      fontSize: font.size.xs,
      lineHeight: font.line.xs,
      fontWeight: font.weight.medium,
      color: c.danger,
    },

    banner: {
      backgroundColor: c.dangerSoft,
      borderLeftWidth: 4,
      borderLeftColor: c.danger,
      borderRadius: radius.sm,
      padding: spacing.md,
    },
    bannerText: {
      color: c.danger,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
      fontWeight: font.weight.medium,
    },

    loading: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.md,
      padding: spacing.xl,
    },
    loadingText: {
      color: c.textDim,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
    },
  })
}
