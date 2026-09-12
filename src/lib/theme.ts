/**
 * Identidade visual do Quati Walker.
 *
 * A paleta vem do lugar: o verde fechado da mata atlântica na ação principal,
 * o ruivo do quati na atenção, e a água do Iguaçu no anel de foco. O fundo
 * claro é quente (areia de rio), não branco de escritório.
 *
 * Todo par texto/fundo usado pelos componentes foi conferido e passa de 4.5:1
 * (WCAG AA). Isso não é preciosismo: o app é lido na rua, com sol na tela e
 * com o celular na mão de quem está segurando uma coleira.
 *
 * Os três sinais do app, e só três — mais que isso ninguém distingue:
 *   primary  ação e sucesso  (confirmar, pago, concluído)
 *   accent   atenção         (aguardando pagamento, reserva vencendo)
 *   danger   falha           (expirou, cancelado, erro de formulário)
 */
import { useColorScheme, useWindowDimensions, type TextStyle } from 'react-native'

export type Theme = {
  colors: {
    /** Fundo da tela inteira. */
    bg: string
    /** Cartões, campos de formulário — um degrau acima do fundo. */
    surface: string
    /** Fundo secundário: botão desabilitado, blocos de apoio. */
    surfaceAlt: string
    text: string
    /** Texto de apoio: rótulos, legendas, explicações. */
    textDim: string
    /** Texto que fica POR CIMA de `primary`. */
    textOnPrimary: string
    primary: string
    primaryPressed: string
    /** Fundo suave da cor principal, para chips e destaques. */
    primarySoft: string
    accent: string
    accentSoft: string
    danger: string
    dangerSoft: string
    /** Contorno de controle — passa de 3:1 contra `bg`, então é visível de verdade. */
    border: string
    /** Linha divisória decorativa. Não serve de contorno de controle. */
    divider: string
    /** Anel de foco. Cor diferente de tudo, para não ser confundida com estado. */
    focus: string
    overlay: string
  }
  spacing: { xs: number; sm: number; md: number; lg: number; xl: number; xxl: number }
  radius: { sm: number; md: number; lg: number; pill: number }
  font: {
    size: { xs: number; sm: number; md: number; lg: number; xl: number }
    line: { xs: number; sm: number; md: number; lg: number; xl: number }
    weight: {
      regular: TextStyle['fontWeight']
      medium: TextStyle['fontWeight']
      bold: TextStyle['fontWeight']
    }
  }
}

/**
 * Medidas não mudam entre claro e escuro. O corpo de texto é 17pt porque o
 * público não é composto de programadores de 25 anos com tela de 6,7".
 */
const shape = {
  spacing: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  radius: { sm: 8, md: 12, lg: 20, pill: 999 },
  font: {
    size: { xs: 13, sm: 15, md: 17, lg: 22, xl: 28 },
    line: { xs: 18, sm: 21, md: 24, lg: 28, xl: 34 },
    weight: { regular: '400', medium: '600', bold: '700' },
  },
} satisfies Omit<Theme, 'colors'>

const light: Theme = {
  colors: {
    bg: '#F6F4EE',
    surface: '#FFFFFF',
    surfaceAlt: '#EDEAE0',
    text: '#14201A',
    textDim: '#5A6660',
    textOnPrimary: '#FFFFFF',
    primary: '#0F6B47',
    primaryPressed: '#0A4E34',
    primarySoft: '#DCEAE1',
    accent: '#9A4F0F',
    accentSoft: '#F4E6D6',
    danger: '#A32C1C',
    dangerSoft: '#F8E3DF',
    border: '#7F857E',
    divider: '#DFDBCF',
    focus: '#0E7C8C',
    overlay: 'rgba(14, 23, 20, 0.45)',
  },
  ...shape,
}

const dark: Theme = {
  colors: {
    bg: '#0E1714',
    surface: '#16211C',
    surfaceAlt: '#1F2C26',
    text: '#E8EDE7',
    textDim: '#9AA89F',
    // No escuro a hierarquia inverte: o verde vira claro e o texto sobre ele
    // vira escuro. Verde escuro com texto branco some no fundo escuro.
    textOnPrimary: '#06110C',
    primary: '#3FBF84',
    primaryPressed: '#35A471',
    primarySoft: '#123326',
    accent: '#E8A15A',
    accentSoft: '#352612',
    danger: '#F08A7A',
    dangerSoft: '#3A1C17',
    border: '#5D6C62',
    divider: '#26332C',
    focus: '#5AD8E8',
    overlay: 'rgba(0, 0, 0, 0.6)',
  },
  ...shape,
}

/**
 * Os temas já prontos, por escala de fonte.
 *
 * Cada objeto de tema é usado como CHAVE de cache de estilo nas telas (WeakMap
 * ou useMemo). Devolver um objeto novo a cada render remontaria todo StyleSheet
 * do aplicativo a cada frame — por isso a escala vira uma entrada de mapa, e o
 * mesmo par (tema, escala) devolve sempre o mesmo objeto.
 */
const porEscala = new Map<string, Theme>()

/**
 * O aumento de fonte do sistema, arredondado para meio passo.
 *
 * Sem arredondar, alguns Android devolvem escalas como 1,1500000001 e cada
 * fração diferente criaria uma entrada nova no mapa. Meio passo é fino o
 * bastante para o texto respirar e grosso o bastante para o cache servir.
 */
function escalaArredondada(fontScale: number): number {
  if (!Number.isFinite(fontScale) || fontScale <= 0) return 1
  return Math.round(Math.min(fontScale, 2.5) * 2) / 2
}

/**
 * O app declara `userInterfaceStyle: automatic`, então quem manda é o sistema.
 *
 * A escala de fonte entra aqui por um motivo concreto: o React Native multiplica
 * o `fontSize` pelo aumento de fonte do aparelho, mas trata o `lineHeight`
 * escrito à mão como valor FIXO. Num ajuste de 150% — comum no público deste
 * aplicativo — o corpo de 17pt vira ~25pt dentro de uma linha de 24pt, e as
 * linhas se encavalam ou a última é cortada. Escalar a altura de linha junto é
 * o que mantém o parágrafo legível.
 *
 * `size` NÃO é escalado aqui: disso o sistema já cuida, e dobrar a conta faria
 * o texto crescer ao quadrado.
 */
export function useTheme(): Theme {
  const escuro = useColorScheme() === 'dark'
  // `useWindowDimensions` é o que re-renderiza quando a pessoa mexe no ajuste de
  // fonte sem fechar o aplicativo.
  const escala = escalaArredondada(useWindowDimensions().fontScale)

  const base = escuro ? dark : light
  if (escala === 1) return base

  const chave = `${escuro ? 'dark' : 'light'}:${escala}`
  const guardado = porEscala.get(chave)
  if (guardado !== undefined) return guardado

  const { line } = base.font
  const criado: Theme = {
    ...base,
    font: {
      ...base.font,
      line: {
        xs: Math.round(line.xs * escala),
        sm: Math.round(line.sm * escala),
        md: Math.round(line.md * escala),
        lg: Math.round(line.lg * escala),
        xl: Math.round(line.xl * escala),
      },
    },
  }
  porEscala.set(chave, criado)
  return criado
}
