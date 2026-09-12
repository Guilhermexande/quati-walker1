/**
 * A ponte entre as telas de animais e a camada de dados.
 *
 * Mesma divisão de useAuth.ts: nenhuma tela conversa com o supabase — ela usa
 * estes hooks. Cada mutação aqui responde por deixar o cache coerente depois
 * de escrever; esquecer uma invalidação faz o tutor cadastrar um animal e não
 * vê-lo na lista, que é o jeito mais rápido de ele achar que o app perdeu o
 * cadastro e fazer tudo de novo.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  archivePet,
  createPet,
  getPet,
  listMyPets,
  setPetPhoto,
  updatePet,
  type Pet,
  type PetInput,
} from '@/api/pets'
import { signPetPhotoUrl, uploadPetPhoto } from '@/api/storage'
import { useSessionStore } from '@/stores/session'

/** A lista de animais do tutor. Quem cria, altera ou arquiva invalida esta. */
const ANIMAIS = ['pets', 'list'] as const

/** Um animal só. O id na chave é o que impede o animal A aparecer na tela do B. */
const animal = (id: string) => ['pets', id] as const

/** As URLs assinadas, guardadas por caminho de arquivo. */
const FOTOS = ['pets', 'foto'] as const

type Alteracao = { id: string; input: PetInput }
type EnvioDeFoto = { id: string; localUri: string }

/**
 * Os animais ativos do tutor. Arquivado não vem — quem some da lista é o
 * `archived_at`, o animal continua no banco por causa do histórico de serviços.
 */
export function useMyPets() {
  const status = useSessionStore((s) => s.status)

  return useQuery({
    queryKey: ANIMAIS,
    queryFn: () => listMyPets(),
    // Depois de sair não há animal nenhum para buscar, e em 'loading' o app
    // ainda nem sabe quem abriu.
    enabled: status !== 'signed_out',
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * Um animal, para a tela de detalhe e a de edição.
 *
 * Aceita null porque o id chega da rota, e a rota pode abrir antes do
 * parâmetro existir. Com id nulo a consulta nem roda.
 */
export function usePet(id: string | null) {
  const queryClient = useQueryClient()

  return useQuery({
    queryKey: animal(id ?? 'sem-id'),
    queryFn: async () => (id === null ? null : await getPet(id)),
    enabled: id !== null,
    // Quem abre o detalhe quase sempre veio da lista, e a lista já traz a linha
    // inteira. Mostrar o que já se tem enquanto a consulta anda evita a tela em
    // branco no meio do caminho.
    placeholderData: () =>
      queryClient.getQueryData<Pet[]>(ANIMAIS)?.find((p) => p.id === id) ?? undefined,
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * A URL assinada da foto.
 *
 * Existe porque `signPetPhotoUrl` é assíncrona — bucket privado não tem URL fixa,
 * a assinatura é uma ida ao servidor. Sem um hook, cada tela repetiria o mesmo
 * useEffect com useState para segurar a resposta.
 */
export function usePetPhoto(path: string | null) {
  return useQuery({
    queryKey: [...FOTOS, path] as const,
    queryFn: () => signPetPhotoUrl(path),
    enabled: path !== null && path !== '',
    // A assinatura vale uma hora; renovar antes disso é ida ao servidor sem
    // ganho nenhum para quem está olhando a mesma foto.
    staleTime: 50 * 60 * 1000,
  })
}

/**
 * Cadastra o animal — só os dados, sem foto.
 *
 * A foto é um segundo passo, feito pela tela depois que isto volta com o id
 * (ver `useUploadPetPhoto`). Amarrar as duas coisas numa mutação só faria uma
 * falha no upload derrubar um cadastro que o servidor já aceitou, e a pessoa
 * digitaria nome, porte, vacina e observações de novo por causa de uma foto.
 */
export function useCreatePet() {
  const queryClient = useQueryClient()

  return useMutation<Pet, Error, PetInput>({
    mutationFn: (input) => createPet(input),
    onSuccess: async (pet) => {
      // Guarda o que o servidor devolveu antes de revalidar: a tela de foto
      // abre com o animal já em mãos, sem um segundo giro de carregamento.
      queryClient.setQueryData<Pet | null>(animal(pet.id), pet)
      await queryClient.invalidateQueries({ queryKey: ANIMAIS })
    },
  })
}

export function useUpdatePet() {
  const queryClient = useQueryClient()

  return useMutation<Pet, Error, Alteracao>({
    mutationFn: ({ id, input }) => updatePet(id, input),
    onSuccess: async (pet) => {
      queryClient.setQueryData<Pet | null>(animal(pet.id), pet)
      await queryClient.invalidateQueries({ queryKey: ANIMAIS })
    },
  })
}

/**
 * Tira o animal de cena.
 *
 * Não é exclusão: `archivePet` carimba `archived_at`. A tela pode falar em
 * "remover", o banco nunca — a FK do histórico de serviços é `on delete
 * restrict`, e apagar a linha quebraria os pedidos antigos do tutor.
 */
export function useArchivePet() {
  const queryClient = useQueryClient()

  return useMutation<void, Error, { id: string }>({
    mutationFn: ({ id }) => archivePet(id),
    onSuccess: async (_vazio, { id }) => {
      // Invalidar e não remover: a linha continua existindo, e uma tela de
      // detalhe aberta agora lê o estado novo em vez de ficar com o antigo.
      await queryClient.invalidateQueries({ queryKey: animal(id) })
      await queryClient.invalidateQueries({ queryKey: ANIMAIS })
    },
  })
}

/**
 * Envia a foto e a liga ao animal.
 *
 * É a operação mais lenta do épico — reduz a imagem, sobe o arquivo e grava o
 * caminho — e a tela mostra o progresso com o `isPending` que a mutação já
 * devolve.
 *
 * Se falhar, nada é desfeito: o animal segue cadastrado, sem foto, e a pessoa
 * tenta de novo quando quiser. É por isso que a tela chama isto depois do
 * cadastro, nunca no meio dele.
 */
export function useUploadPetPhoto() {
  const queryClient = useQueryClient()

  return useMutation<Pet, Error, EnvioDeFoto>({
    mutationFn: async ({ id, localUri }) => {
      const path = await uploadPetPhoto(id, localUri)

      // Subir o arquivo não mexe na tabela. Sem este segundo passo a foto fica
      // no bucket e a tela continua mostrando o espaço vazio.
      return await setPetPhoto(id, path)
    },
    onSuccess: async (pet) => {
      queryClient.setQueryData<Pet | null>(animal(pet.id), pet)

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: animal(pet.id) }),
        queryClient.invalidateQueries({ queryKey: ANIMAIS }),
        // Trocar a foto grava por cima do mesmo caminho, então o photo_path não
        // muda e a URL guardada continuaria servindo a imagem antiga. Assinar
        // de novo dá uma URL diferente, e é o que faz a foto nova aparecer.
        queryClient.invalidateQueries({ queryKey: FOTOS }),
      ])
    },
  })
}
