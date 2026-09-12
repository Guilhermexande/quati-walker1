/**
 * A casca do aplicativo: os provedores, a sessão e o guarda de rota.
 *
 * É o único arquivo que precisa saber quem entrou antes de existir tela. Faz
 * três coisas, e nenhuma delas cabe em outro lugar:
 *
 *   1. monta QueryClient e SafeAreaProvider, que valem para o app inteiro;
 *   2. ouve o Supabase Auth e traduz "tem sessão" + "qual é o papel" para o
 *      estado da store (src/stores/session.ts);
 *   3. impede que alguém fique numa área que não é a dele.
 *
 * `onAuthChange` é a única coisa de `src/api` importada fora de um hook, e é
 * proposital: mudança de sessão não é uma busca, é um aviso que chega sozinho —
 * não existe useQuery para isso. Todo o resto de `app/` usa hooks.
 */
import * as React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Stack, router, useSegments, type Href } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { onAuthChange } from '@/api/auth'
import { Body, Button, ErrorBanner, Loading, Screen, Title } from '@/components/ui'
import { useMyProfile, useSignOutMutation } from '@/hooks/useAuth'
import { useTheme } from '@/lib/theme'
import { useSessionStore, type Role, type SessionState } from '@/stores/session'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // O celular do passeador está na rua: sinal ruim é o caso normal, não a
      // exceção. Três tentativas com recuo cobrem o túnel e o elevador sem
      // deixar a tela girando por meio minuto.
      retry: 2,
      staleTime: 30_000,
      // Não existe janela no celular. O gatilho de foco do react-query depende
      // de AppState, que este app não liga — deixá-lo ligado só promete uma
      // revalidação que nunca acontece.
      refetchOnWindowFocus: false,
    },
    // Escrita não se repete sozinha: criar perfil duas vezes bate na constraint
    // e pagar duas vezes é pior. Quem decide repetir é a pessoa, no botão.
    mutations: { retry: 0 },
  },
})

export default function RootLayout(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        {/* O app declara userInterfaceStyle: automatic; a barra do sistema
            segue junto, senão os ícones somem no tema escuro. */}
        <StatusBar style="auto" />
        <Sessao />
      </SafeAreaProvider>
    </QueryClientProvider>
  )
}

/**
 * Descobre quem entrou e só então entrega a navegação.
 *
 * Enquanto o status é 'loading' não existe Stack montado — e isso é metade da
 * solução do laço de redirecionamento. A outra metade está em `paraOndeIr`:
 * sem navegação montada não há para onde redirecionar cedo demais, e a
 * primeira tela a aparecer já é a certa.
 */
function Sessao(): React.JSX.Element {
  const theme = useTheme()
  const status = useSessionStore((s) => s.status)
  const role = useSessionStore((s) => s.role)
  const perfil = useMyProfile()

  // `undefined` é "o supabase ainda não avisou nada". Diferente de `null`, que
  // já é resposta fechada: não tem ninguém logado neste aparelho.
  const [userId, setUserId] = React.useState<string | null | undefined>(undefined)

  React.useEffect(() => onAuthChange((id) => setUserId(id)), [])

  // A store é atualizada aqui, e não dentro do aviso do supabase: ele segura
  // uma trava enquanto avisa os inscritos, e qualquer chamada ao supabase
  // disparada lá de dentro pode acabar esperando por ela mesma. Efeito roda
  // depois do render, já fora da trava.
  React.useEffect(() => {
    if (userId === undefined) return

    if (userId === null) {
      // Saiu, ou o token venceu de vez.
      const tinhaAlguem = useSessionStore.getState().userId !== null
      useSessionStore.getState().setSignedOut()

      // Limpar o cache só depois de marcar a saída: com a sessão já fora, as
      // consultas ficam desligadas e nenhuma corre atrás do que acabou de ser
      // apagado. E apagar importa — o celular pode ser emprestado.
      if (tinhaAlguem) queryClient.removeQueries()
      return
    }

    // Já se sabe quem é, mas ainda não o papel — e é o papel que escolhe a
    // área. Anunciar 'ready' agora jogaria todo passeador na tela de tutor.
    if (perfil.isPending || perfil.isError) return

    useSessionStore.getState().setSession(userId, perfil.data?.role ?? null)
  }, [userId, perfil.isPending, perfil.isError, perfil.data])

  // O expo-router tipa useSegments() a partir das rotas que conhece, e hoje o
  // tipo mais estreito tem um elemento só — ler o segundo seria erro de tipo,
  // ainda que em tempo de execução ele exista ("(auth)", "role"). A leitura
  // como lista de tamanho aberto é o que descreve o valor de verdade.
  const segments = useSegments() as readonly (string | undefined)[]
  const grupo = segments[0]
  const tela = segments[1]

  React.useEffect(() => {
    const destino = paraOndeIr(status, role, grupo, tela)
    if (destino !== null) router.replace(destino)
  }, [status, role, grupo, tela])

  if (status === 'loading') {
    // Sem o perfil o app não sabe qual área abrir. Ficar girando para sempre
    // seria a pior saída: aqui a pessoa vê o motivo e tem os dois caminhos.
    if (perfil.isError) {
      return (
        <FalhaAoAbrir
          mensagem={perfil.error?.message ?? 'Não foi possível falar com o servidor.'}
          tentando={perfil.isFetching}
          aoTentarDeNovo={() => void perfil.refetch()}
        />
      )
    }

    return (
      <Screen>
        <Loading />
      </Screen>
    )
  }

  return (
    <Stack
      screenOptions={{
        // Cada tela desenha o próprio título dentro de <Screen>, que já respeita
        // a área segura. Um cabeçalho aqui empilharia recuo em cima de recuo.
        headerShown: false,
        // Sem isto o fundo por trás da transição é branco, e no tema escuro ele
        // pisca a cada troca de tela.
        contentStyle: { backgroundColor: theme.colors.bg },
      }}
    />
  )
}

/**
 * Para onde a pessoa tem que ir, ou `null` quando ela já está no lugar certo e
 * ninguém deve mexer na navegação.
 *
 * Devolver `null` cedo é o que evita o laço: redirecionar durante 'loading', ou
 * disputar a entrada com `app/index.tsx`, é exatamente o que faz a tela piscar.
 *
 * O destino de cada estado é o mesmo de `app/index.tsx`, que escolhe a primeira
 * tela — se um mudar, o outro muda junto. O que existe só aqui são as exceções
 * de quem está no meio de um fluxo e não pode ser arrancado dele.
 */
function paraOndeIr(
  status: SessionState['status'],
  role: Role | null,
  grupo: string | undefined,
  tela: string | undefined,
): Href | null {
  // Ainda lendo a sessão guardada no aparelho — não há nem navegação montada.
  if (status === 'loading') return null

  // A entrada (`app/index.tsx`, sem grupo nenhum na rota) decide sozinha para
  // onde manda. O guarda não disputa o volante com ela.
  if (grupo === undefined) return null

  if (status === 'signed_out') {
    // Qualquer tela de (auth) serve para quem está de fora — menos a escolha de
    // papel, que é de quem já entrou e ainda não tem cadastro.
    return grupo === '(auth)' && tela !== 'role' ? null : '/(auth)/login'
  }

  if (status === 'no_profile') {
    return grupo === '(auth)' && tela === 'role' ? null : '/(auth)/role'
  }

  if (role === 'walker') {
    // O cadastro do passeador não acaba quando o perfil existe: o papel já é
    // 'walker', mas sem as preferências salvas não há linha em walker_profiles
    // e nenhum pedido chega. Essas duas telas continuam em (auth) de propósito,
    // e a escolha de papel é quem leva de uma para a outra — se o guarda
    // reagisse ao 'ready' antes dela, a tela de preferências ficaria
    // inalcançável e o passeador nunca receberia serviço.
    if (grupo === '(auth)') {
      return tela === 'role' || tela === 'walker-setup' ? null : '/(walker)/painel'
    }
    return grupo === '(walker)' ? null : '/(walker)/painel'
  }

  // Admin não tem área própria no aplicativo: a administração é feita fora
  // dele. Até existir uma, cai na área de tutor — que no pior caso mostra o
  // próprio cadastro.
  return grupo === '(client)' ? null : '/(client)/inicio'
}

function FalhaAoAbrir({
  mensagem,
  tentando,
  aoTentarDeNovo,
}: {
  mensagem: string
  tentando: boolean
  aoTentarDeNovo: () => void
}): React.JSX.Element {
  const sair = useSignOutMutation()

  return (
    <Screen scroll>
      <Title>Não deu para abrir o seu cadastro</Title>
      <Body>
        Você entrou na sua conta, mas o aplicativo não conseguiu buscar os seus dados. Sem eles
        ele não sabe se abre a área de tutor ou a de passeador.
      </Body>
      <ErrorBanner message={mensagem} />
      <Button label="Tentar de novo" onPress={aoTentarDeNovo} loading={tentando} />
      <Button
        label="Sair e entrar de novo"
        variant="ghost"
        onPress={() => sair.mutate()}
        loading={sair.isPending}
      />
      {sair.error !== null ? <ErrorBanner message={sair.error.message} /> : null}
    </Screen>
  )
}
