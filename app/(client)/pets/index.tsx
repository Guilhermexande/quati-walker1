/**
 * Os animais do tutor, em lista.
 *
 * Esta tela tem duas versões, e a que mais gente vê é a vazia: quem acabou de
 * criar a conta chega aqui sem nenhum animal cadastrado. Por isso o vazio não é
 * um "nada encontrado" — é o convite, com o motivo e o botão.
 *
 * O aviso de vacina aparece AQUI de propósito. Quem recusa o serviço é o
 * trigger `assert_request_insert`, que exige antirrábica válida (Termos §8);
 * descobrir isso no meio do pedido, com dia, hora e passeador já escolhidos, é
 * a pior hora possível. A lista é o lugar onde a pessoa ainda tem tempo de
 * resolver antes de precisar.
 */
import * as React from 'react'
import {
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'

import type { Pet } from '@/api/pets'
import { Body, Button, ErrorBanner, Loading, Screen, Title } from '@/components/ui'
import { useMyPets, usePetPhoto } from '@/hooks/usePets'
import { useTheme, type Theme } from '@/lib/theme'
import { vacinaEstaVencida } from '@/schemas/pet'

/** As telas vizinhas. Juntas aqui em cima para o dia em que o caminho mudar. */
const CADASTRO = '/(client)/pets/novo'
const animalEm = (id: string) => `/(client)/pets/${id}` as const

const ESPECIE: Record<Pet['species'], string> = {
  dog: 'Cachorro',
  cat: 'Gato',
}

/**
 * Gato não passeia (ADR decisão 1): o serviço dele é visita em casa, e o banco
 * recusa o contrário em `assert_service_matches_species`. Dizer isso embaixo do
 * nome de cada animal é mais barato que explicar depois, na tela do pedido.
 */
const SERVICO: Record<Pet['species'], string> = {
  dog: 'passeio',
  cat: 'visita em casa',
}

export default function MeusAnimais(): React.JSX.Element {
  const router = useRouter()
  const theme = useTheme()
  const s = useStyles()
  const animais = useMyPets()

  const lista = animais.data ?? []

  function irParaCadastro(): void {
    router.push(CADASTRO)
  }

  function voltar(): void {
    // A raiz não mostra cabeçalho (headerShown: false), então este botão é a
    // única saída desenhada. Quem abriu a lista por link não tem para onde
    // voltar — daí o destino fixo em vez de um back que não faria nada.
    if (router.canGoBack()) router.back()
    else router.replace('/(client)/inicio')
  }

  function corpo(): React.JSX.Element {
    if (animais.isPending) return <Loading />

    if (animais.isError) {
      return (
        <View style={s.centro}>
          <Text style={s.blocoTitulo} accessibilityRole="header">
            Não deu para carregar os seus animais
          </Text>
          <ErrorBanner message={animais.error.message} />
          <Button
            label="Tentar de novo"
            onPress={() => void animais.refetch()}
            loading={animais.isFetching}
          />
        </View>
      )
    }

    if (lista.length === 0) {
      return (
        <View style={s.centro}>
          <Text style={s.blocoTitulo} accessibilityRole="header">
            Você ainda não cadastrou nenhum animal
          </Text>
          <Body>
            Cadastre seu cão ou seu gato para poder pedir um passeio ou uma visita em casa — é
            o animal que o passeador vai atender.
          </Body>
          <Body dim>
            Deixe a carteirinha de vacinação por perto: a data da vacina antirrábica é
            obrigatória para pedir qualquer serviço.
          </Body>
          <Button label="Cadastrar meu animal" onPress={irParaCadastro} />
        </View>
      )
    }

    return (
      <FlatList
        data={lista}
        keyExtractor={(pet) => pet.id}
        renderItem={({ item }) => (
          <CartaoDoAnimal pet={item} aoTocar={() => router.push(animalEm(item.id))} />
        )}
        style={s.lista}
        contentContainerStyle={s.listaConteudo}
        refreshControl={
          // Lista de dados que mudam devagar, mas a foto que acabou de subir e o
          // animal cadastrado em outro aparelho aparecem por aqui sem a pessoa
          // precisar sair e voltar na tela.
          <RefreshControl
            refreshing={animais.isRefetching}
            onRefresh={() => void animais.refetch()}
            tintColor={theme.colors.primary}
            colors={[theme.colors.primary]}
            progressBackgroundColor={theme.colors.surface}
          />
        }
      />
    )
  }

  // A FlatList rola sozinha e não pode morar dentro de uma ScrollView. Os
  // outros três estados são texto solto numa View fixa — e quem aumenta a fonte
  // do sistema, como boa parte do público deste app, perde o botão do fim. Daí
  // a rolagem só quando não há lista.
  const temLista = !animais.isPending && !animais.isError && lista.length > 0

  return (
    <Screen scroll={!temLista}>
      <Title>Meus animais</Title>

      {corpo()}

      {lista.length > 0 ? (
        <Button label="Cadastrar outro animal" onPress={irParaCadastro} />
      ) : null}

      <Button label="Voltar" variant="ghost" onPress={voltar} />
    </Screen>
  )
}

function CartaoDoAnimal({ pet, aoTocar }: { pet: Pet; aoTocar: () => void }): React.JSX.Element {
  const s = useStyles()

  const resumo = resumoDoAnimal(pet)
  const aviso = avisoDaVacina(pet.rabies_valid_until)

  return (
    <Pressable
      onPress={aoTocar}
      accessibilityRole="button"
      // O leitor de tela anuncia o cartão inteiro numa frase só; sem isto ele
      // leria foto, nome, resumo e aviso como quatro paradas separadas.
      accessibilityLabel={`${pet.name}. ${resumo}.${aviso === null ? '' : ` Atenção: ${aviso}`}`}
      accessibilityHint="Toque para ver e alterar os dados deste animal."
      style={({ pressed }) => [s.cartao, pressed && s.cartaoPressionado]}
    >
      <View style={s.linha}>
        <Foto pet={pet} />

        {/* O texto precisa de um pai flexível, senão o nome longo escapa da
            largura da tela em vez de quebrar. */}
        <View style={s.textos}>
          <Text style={s.nome} numberOfLines={2}>
            {pet.name}
          </Text>
          <Text style={s.resumo} numberOfLines={2}>
            {resumo}
          </Text>
        </View>

        {/* Nome, foto e resumo desenham um cartão de informação, não um botão:
            sem esta seta o único sinal de que dá para tocar aparece depois do
            toque. O leitor de tela já ouve o accessibilityHint do Pressable e
            não precisa ouvir um chevron. */}
        <Text style={s.seta} accessibilityElementsHidden importantForAccessibility="no">
          ›
        </Text>
      </View>

      {aviso === null ? null : (
        <View style={s.aviso}>
          <Text style={s.avisoTexto}>{aviso}</Text>
        </View>
      )}
    </Pressable>
  )
}

/**
 * A foto, ou a inicial do nome no lugar dela.
 *
 * O bucket é privado: a URL é assinada a cada leitura, e enquanto a assinatura
 * não volta — ou quando ela falha — o espaço já fica ocupado pela inicial. Sem
 * isso o cartão nasce com um buraco e muda de altura quando a imagem chega.
 */
function Foto({ pet }: { pet: Pet }): React.JSX.Element {
  const s = useStyles()
  const foto = usePetPhoto(pet.photo_path)

  const url = foto.data ?? null
  if (url === null) {
    return (
      <View style={s.fotoVazia}>
        <Text style={s.fotoInicial}>{pet.name.trim().charAt(0).toUpperCase()}</Text>
      </View>
    )
  }

  return (
    <Image
      source={{ uri: url }}
      style={s.foto}
      // Foto de animal não é ícone de interface: inverter as cores dela no modo
      // de acessibilidade do iOS deixaria o cachorro roxo.
      accessibilityIgnoresInvertColors
    />
  )
}

function resumoDoAnimal(pet: Pet): string {
  const partes = [ESPECIE[pet.species]]

  const raca = pet.breed?.trim()
  if (raca !== undefined && raca !== '') partes.push(raca)

  partes.push(SERVICO[pet.species])
  return partes.join(' · ')
}

/**
 * O que dizer sobre a vacina, ou `null` quando ela está em dia.
 *
 * Mesma régua de `vacinaEstaVencida` — a do trigger do banco: sem data conta
 * como vencida. As duas mensagens são diferentes porque a saída é diferente:
 * uma se resolve digitando a data da carteirinha, a outra exige ir ao
 * veterinário antes.
 */
function avisoDaVacina(rabiesValidUntil: string | null): string | null {
  if (!vacinaEstaVencida(rabiesValidUntil)) return null

  const vencimento = dataPorExtenso(rabiesValidUntil)
  if (vencimento === null) {
    return 'Falta informar a vacina antirrábica. Sem a data da carteirinha não dá para pedir passeio nem visita para ele — toque para informar.'
  }

  return `Vacina antirrábica vencida em ${vencimento}. Renove no veterinário e atualize a data aqui para voltar a pedir serviços.`
}

/**
 * 'AAAA-MM-DD' vira '07/03/2026', ou `null` quando não é data de calendário.
 *
 * O `null` cobre mais do que campo vazio: '2026-02-31' está bem escrito e não
 * existe. Mostrar "vencida em 31/02/2026" faria o tutor procurar na carteirinha
 * uma data que ele nunca vai achar — melhor cair no texto genérico.
 */
function dataPorExtenso(iso: string | null): string | null {
  if (iso === null) return null

  // O padrão NaN cobre o caso de o split não render três pedaços; sem ele o
  // tipo seria `number | undefined` e a saída seria um `!` mentindo para quem lê.
  const [ano = NaN, mes = NaN, dia = NaN] = iso.trim().split('-').map(Number)

  // Data inválida é normalizada para outro dia pelo Date, e é essa diferença
  // que a denuncia. Date local, nunca UTC: em Foz (UTC-3) o UTC trocaria o dia.
  const data = new Date(ano, mes - 1, dia)
  const real = data.getFullYear() === ano && data.getMonth() === mes - 1 && data.getDate() === dia
  if (!real) return null

  return `${`${dia}`.padStart(2, '0')}/${`${mes}`.padStart(2, '0')}/${ano}`
}

/**
 * Um cartão por animal, mais a foto de cada um: a folha é criada uma vez por
 * tema, e não uma vez por linha da lista.
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

  const FOTO = 64

  return StyleSheet.create({
    // Ocupa o que sobra entre o título e os botões do rodapé, e deixa o rodapé
    // fixo: o botão de cadastrar não some quando a lista é longa.
    lista: { flex: 1 },
    listaConteudo: { gap: spacing.md, paddingBottom: spacing.sm },

    centro: { flex: 1, justifyContent: 'center', gap: spacing.md },
    seta: {
      color: c.textDim,
      fontSize: font.size.xl,
      lineHeight: font.line.xl,
      fontWeight: font.weight.medium,
    },
    blocoTitulo: {
      color: c.text,
      fontSize: font.size.lg,
      lineHeight: font.line.lg,
      fontWeight: font.weight.bold,
    },

    cartao: {
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.divider,
      borderRadius: radius.lg,
      padding: spacing.md,
      gap: spacing.md,
    },
    cartaoPressionado: { backgroundColor: c.primarySoft, borderColor: c.primary },

    linha: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    textos: { flex: 1, gap: spacing.xs },

    foto: { width: FOTO, height: FOTO, borderRadius: radius.md, backgroundColor: c.surfaceAlt },
    fotoVazia: {
      width: FOTO,
      height: FOTO,
      borderRadius: radius.md,
      backgroundColor: c.primarySoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    fotoInicial: {
      color: c.primary,
      fontSize: font.size.lg,
      lineHeight: font.line.lg,
      fontWeight: font.weight.bold,
    },

    nome: {
      color: c.text,
      fontSize: font.size.md,
      lineHeight: font.line.md,
      fontWeight: font.weight.bold,
    },
    resumo: {
      color: c.textDim,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
    },

    // Atenção, não falha: não é erro do aplicativo, é uma pendência do tutor —
    // e `danger` fica reservado ao que quebrou. A barra lateral e o texto dizem
    // o mesmo que a cor, para quem não distingue as duas.
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
  })
}
