/**
 * A casa do tutor — a confirmação de que o cadastro deu certo e a porta para o
 * que já existe.
 *
 * O Épico 1 entrega conta, perfil e papel; o Épico 2 abriu os animais, e é para
 * lá que o botão leva. Pedido, PIX e avaliação ainda não estão aqui, e a tela
 * diz isso sem enrolar. Ela não segura regra de negócio nenhuma: cada épico
 * novo troca um item da lista de espera por um caminho de verdade.
 */
import * as React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'

import { Body, Button, ErrorBanner, Screen, Title } from '@/components/ui'
import { useMyProfile, useSignOutMutation } from '@/hooks/useAuth'
import { useTheme, type Theme } from '@/lib/theme'

/**
 * O que ainda não chegou. Cadastrar animal saiu daqui quando o Épico 2 entrou —
 * item que já funciona vira botão, não promessa.
 */
const PROXIMOS_PASSOS = [
  'Pedir um passeio para o cão, ou uma visita em casa para o gato',
  'Pagar por PIX e acompanhar o serviço do começo ao fim',
  'Avaliar quem cuidou do seu animal',
]

export default function InicioDoTutor(): React.JSX.Element {
  const s = useEstilos()
  const router = useRouter()
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
        <Text style={s.etiquetaTexto}>Conta de tutor</Text>
      </View>

      <Body dim>
        Seu cadastro está pronto. O resto do aplicativo chega por atualização — você não vai
        precisar baixar nada de novo.
      </Body>

      {/* O caminho para o animal vem antes da lista de espera: sem animal
          cadastrado não há passeio nem visita para pedir depois. O texto serve
          para quem tem zero animais e para quem já tem três. */}
      <Body>
        Seu cão e seu gato ficam aqui, com a foto e a vacina de cada um — é o animal
        cadastrado que o passeador vai atender.
      </Body>

      <Button label="Meus animais" onPress={() => router.push('/(client)/pets')} />

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
