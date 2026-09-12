/**
 * A porta de entrada. Não desenha nada de próprio: lê o estado da sessão e
 * manda a pessoa para o lugar dela.
 *
 * É a primeira tela que o Stack monta, e por isso é ela — e não o guarda do
 * `_layout` — quem escolhe o destino na abertura. Assim a navegação acontece
 * uma vez só, e ninguém vê a tela de entrar piscando no caminho.
 */
import * as React from 'react'
import { Redirect } from 'expo-router'

import { Loading, Screen } from '@/components/ui'
import { useSessionStore } from '@/stores/session'

export default function Entrada(): React.JSX.Element {
  const status = useSessionStore((s) => s.status)
  const role = useSessionStore((s) => s.role)

  // Hoje o `_layout` só monta a navegação depois de saber quem entrou, então
  // este caso quase não acontece. Fica assim mesmo: um Redirect disparado
  // antes de a sessão ser lida manda quem já tem conta para a tela de entrar, e
  // arranca a pessoa de lá um segundo depois.
  if (status === 'loading') {
    return (
      <Screen>
        <Loading />
      </Screen>
    )
  }

  if (status === 'signed_out') return <Redirect href="/(auth)/login" />

  // Conta criada no Auth, cadastro ainda não. É aqui que se escolhe entre tutor
  // e passeador.
  if (status === 'no_profile') return <Redirect href="/(auth)/role" />

  // Admin usa a área de tutor por enquanto — ver a explicação em `paraOndeIr`,
  // no `_layout`.
  return role === 'walker' ? <Redirect href="/(walker)/painel" /> : <Redirect href="/(client)/inicio" />
}
