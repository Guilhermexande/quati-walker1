/**
 * A ponte entre as telas de entrada/cadastro e a camada de dados.
 *
 * Nenhuma tela conversa com o supabase — ela usa estes hooks. Cada mutação
 * aqui é responsável por duas coisas além de chamar a API: deixar o cache do
 * React Query coerente e mover a store de sessão para o estado certo. Se uma
 * das duas ficar de fora, o app fica preso na tela errada.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { signInWithEmail, signOut, signUpWithEmail } from '@/api/auth'
import {
  createMyProfile,
  getMyProfile,
  getMyWalkerProfile,
  saveWalkerProfile,
  type Profile,
  type WalkerProfile,
} from '@/api/profiles'
import { useSessionStore } from '@/stores/session'

/** Chave do perfil da pessoa logada. Quem cria ou altera perfil invalida esta. */
const PERFIL_ME = ['profile', 'me'] as const
const PERFIL_WALKER = ['profile', 'walker'] as const

type Credenciais = { email: string; password: string }

// As telas passam exatamente o que a API aceita; tirar o formato de lá evita
// duas descrições da mesma coisa saindo de sincronia.
type DadosDoPerfil = Parameters<typeof createMyProfile>[0]
type DadosDoWalker = Parameters<typeof saveWalkerProfile>[0]

/**
 * O perfil de quem está logado — é ele que diz o papel, e o papel decide a
 * rota. Devolve null quando a conta existe no Auth mas ainda não tem perfil.
 */
export function useMyProfile() {
  const status = useSessionStore((s) => s.status)

  return useQuery({
    queryKey: PERFIL_ME,
    queryFn: () => getMyProfile(),
    // Em 'loading' o app ainda não sabe quem abriu — e é esta consulta que
    // descobre. Depois de sair não há perfil nenhum para buscar.
    enabled: status !== 'signed_out',
    staleTime: 5 * 60 * 1000,
  })
}

export function useSignIn() {
  const queryClient = useQueryClient()

  return useMutation<string, Error, Credenciais>({
    mutationFn: ({ email, password }) => signInWithEmail(email, password),
    onSuccess: async (userId) => {
      // O celular pode ser emprestado. Nada do usuário anterior sobrevive à
      // troca. `removeQueries` e não `clear` porque clear derruba também a
      // mutação que está rodando agora — esta aqui.
      queryClient.removeQueries()

      // Buscar o perfil aqui, e não depois, mantém o botão "Entrar" girando até
      // o app saber o papel da pessoa. Sem isso a tela de escolher papel pisca
      // no caminho para quem já tem cadastro.
      const perfil = await queryClient.fetchQuery({
        queryKey: PERFIL_ME,
        queryFn: () => getMyProfile(),
      })

      useSessionStore.getState().setSession(userId, perfil?.role ?? null)
    },
  })
}

export function useSignUp() {
  const queryClient = useQueryClient()

  return useMutation<string, Error, Credenciais>({
    mutationFn: ({ email, password }) => signUpWithEmail(email, password),
    onSuccess: (userId) => {
      queryClient.removeQueries()

      // Conta recém-criada não tem perfil — este é o buraco entre o Auth e a
      // tabela profiles. 'no_profile' é o que leva à tela de escolher papel.
      useSessionStore.getState().setSession(userId, null)
    },
  })
}

export function useSignOutMutation() {
  const queryClient = useQueryClient()

  return useMutation<void, Error, void>({
    mutationFn: () => signOut(),
    onSuccess: () => {
      // Sem isto, quem entrar depois neste aparelho vê os pedidos e os animais
      // de quem saiu enquanto a tela recarrega.
      queryClient.removeQueries()
      useSessionStore.getState().setSignedOut()
    },
  })
}

export function useCreateProfile() {
  const queryClient = useQueryClient()

  return useMutation<Profile, Error, DadosDoPerfil>({
    mutationFn: (input) => createMyProfile(input),
    onSuccess: async (perfil) => {
      // Guarda o que o servidor devolveu antes de revalidar: assim a troca de
      // tela é imediata e ninguém vê a escolha de papel duas vezes.
      queryClient.setQueryData<Profile | null>(PERFIL_ME, perfil)
      useSessionStore.getState().setSession(perfil.id, perfil.role)

      await queryClient.invalidateQueries({ queryKey: PERFIL_ME })
    },
  })
}

export function useSaveWalkerProfile() {
  const queryClient = useQueryClient()

  return useMutation<WalkerProfile, Error, DadosDoWalker>({
    mutationFn: (input) => saveWalkerProfile(input),
    onSuccess: async (walker) => {
      queryClient.setQueryData<WalkerProfile | null>(PERFIL_WALKER, walker)
      await queryClient.invalidateQueries({ queryKey: PERFIL_WALKER })
    },
  })
}

/**
 * O perfil de passeador — raio, espécies aceitas, bio. Só faz sentido para
 * quem tem papel 'walker'; para os outros a linha nem existe.
 */
export function useMyWalkerProfile() {
  const role = useSessionStore((s) => s.role)

  return useQuery({
    queryKey: PERFIL_WALKER,
    queryFn: () => getMyWalkerProfile(),
    enabled: role === 'walker',
    staleTime: 5 * 60 * 1000,
  })
}
