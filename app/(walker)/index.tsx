/**
 * A casa do passeador — por enquanto, a confirmação de que o cadastro deu certo.
 *
 * O Épico 1 entrega conta, perfil e papel. Disponibilidade, pedidos, execução do
 * serviço e ganhos são os próximos. Esta tela existe para o app abrir em algum
 * lugar que faça sentido e para dizer, sem enrolar, o que ainda falta — inclusive
 * o que depende do passeador, não do aplicativo.
 */
import * as React from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { Body, Button, ErrorBanner, Screen, Title } from '@/components/ui'
import { useMyProfile, useSignOutMutation } from '@/hooks/useAuth'
import { useTheme, type Theme } from '@/lib/theme'

const PROXIMOS_PASSOS = [
  'Avisar quando você está disponível para atender',
  'Ver os pedidos perto de você e aceitar os que couberem na sua agenda',
  'Iniciar e encerrar o serviço pelo aplicativo, com hora e lugar registrados',
  'Acompanhar quanto você já recebeu',
]

export default function InicioDoPasseador(): React.JSX.Element {
  const s = useEstilos()
  const perfil = useMyProfile()
  const sair = useSignOutMutation()

  // Sem tela de carregando de propósito: chegar aqui já exige o perfil buscado.
  // O único instante sem nome é logo depois de sair, e aí um giro na tela
  // inteira chamaria mais atenção que o cumprimento curto.
  const nome = primeiroNome(perfil.data?.full_name ?? '')

  return (
    <Screen scroll>
      <Title>{nome === '' ? 'Olá!' : `Olá, ${nome}!`}</Title>

      <View style={s.etiqueta}>
        <Text style={s.etiquetaTexto}>Conta de passeador</Text>
      </View>

      <Body dim>
        Seu cadastro está pronto. O resto do aplicativo chega por atualização — você não vai
        precisar baixar nada de novo.
      </Body>

      {/* Isto não é enfeite: sem conta do Mercado Pago ligada não há para onde
          mandar o dinheiro, e o passeador não entra na fila de pedidos. */}
      <View style={s.aviso}>
        <Text style={s.avisoTexto}>
          Antes de receber pedidos, você ainda vai ligar a sua conta do Mercado Pago — é nela que
          o pagamento cai — e passar pela conferência dos seus documentos.
        </Text>
      </View>

      <View style={s.cartao}>
        <Text style={s.cartaoTitulo} accessibilityRole="header">
          O que vem a seguir
        </Text>

        {PROXIMOS_PASSOS.map((passo) => (
          <View key={passo} style={s.item}>
            <View style={s.ponto} />
            {/* O texto precisa de um pai flexível, senão a linha longa escapa
                da largura da tela em vez de quebrar. */}
            <View style={s.itemTexto}>
              <Body>{passo}</Body>
            </View>
          </View>
        ))}
      </View>

      <View style={s.espaco} />

      {sair.error !== null ? <ErrorBanner message={sair.error.message} /> : null}

      <Button
        label="Sair da conta"
        variant="ghost"
        onPress={() => sair.mutate()}
        loading={sair.isPending}
      />
    </Screen>
  )
}

function primeiroNome(nomeCompleto: string): string {
  // `split` sempre devolve ao menos um item, mas o compilador não sabe disso —
  // e o nome pode chegar só com espaços.
  const partes = nomeCompleto.trim().split(' ')
  return partes[0] ?? ''
}

function useEstilos(): ReturnType<typeof criarEstilos> {
  const theme = useTheme()
  return React.useMemo(() => criarEstilos(theme), [theme])
}

function criarEstilos(t: Theme) {
  const { colors: c, spacing, radius, font } = t

  return StyleSheet.create({
    etiqueta: {
      alignSelf: 'flex-start',
      backgroundColor: c.primarySoft,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
    },
    etiquetaTexto: {
      color: c.primary,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
      fontWeight: font.weight.medium,
    },

    // Mesma forma do ErrorBanner, na cor de atenção: é aviso, não falha.
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

    cartao: {
      backgroundColor: c.surface,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: c.divider,
      padding: spacing.lg,
      gap: spacing.md,
    },
    cartaoTitulo: {
      color: c.textDim,
      fontSize: font.size.xs,
      lineHeight: font.line.xs,
      fontWeight: font.weight.bold,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
    },

    item: { flexDirection: 'row', gap: spacing.md },
    // 8pt alinha a bolinha com o meio da primeira linha do texto (17/24).
    ponto: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: c.primary,
      marginTop: 8,
    },
    itemTexto: { flex: 1 },

    // Empurra o botão para o rodapé quando sobra tela, e some quando não sobra.
    espaco: { flex: 1, minHeight: spacing.lg },
  })
}
