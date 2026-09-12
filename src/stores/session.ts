/**
 * Quem está usando o app agora, e em que papel.
 *
 * O estado 'no_profile' existe por causa de um buraco real: o Supabase Auth
 * cria o usuário antes de existir a linha em public.profiles. Entre um e outro
 * a pessoa está autenticada e mesmo assim o app não sabe se ela é tutor ou
 * passeador. É esse intervalo que manda alguém para a tela de escolher papel.
 *
 * A store guarda o que já se sabe — ela não descobre nada sozinha. Quem
 * descobre são os hooks (src/hooks/useAuth.ts) e o _layout.
 */
import { create } from 'zustand'

export type Role = 'client' | 'walker' | 'admin'

export type SessionState = {
  status: 'loading' | 'signed_out' | 'no_profile' | 'ready'
  userId: string | null
  role: Role | null
  setSignedOut(): void
  setSession(userId: string, role: Role | null): void
}

export const useSessionStore = create<SessionState>()((set) => ({
  // Começa em 'loading' porque a sessão guardada no aparelho ainda não foi
  // lida. Quem abre o app já logado não pode ver a tela de entrar piscando.
  status: 'loading',
  userId: null,
  role: null,

  setSignedOut: () =>
    set((state) =>
      state.status === 'signed_out' && state.userId === null && state.role === null
        ? state
        : { status: 'signed_out', userId: null, role: null },
    ),

  setSession: (userId, role) =>
    set((state) => {
      const status: SessionState['status'] = role === null ? 'no_profile' : 'ready'

      // Devolver o mesmo objeto faz o zustand não avisar ninguém. Isso importa:
      // o supabase renova o token sozinho de tempos em tempos e avisa a cada
      // renovação — sem esta guarda, o app inteiro re-renderiza à toa.
      return state.status === status && state.userId === userId && state.role === role
        ? state
        : { status, userId, role }
    }),
}))
