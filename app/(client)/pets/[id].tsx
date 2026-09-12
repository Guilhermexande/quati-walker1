/**
 * Um animal do tutor: ver, corrigir e tirar da lista.
 *
 * A tela é o cadastro inteiro em modo de edição, não uma ficha com um botão
 * "editar" em cima. O motivo é o que o banco cobra depois: sem a validade da
 * antirrábica (`assert_request_insert`, Termos §8) nenhum pedido de serviço
 * passa, e quem descobre isso na hora de marcar o passeio já perdeu a viagem.
 * Aqui o campo está sempre à mão — e quando a vacina está vencida ou faltando,
 * ele sobe para o topo da tela, dentro do aviso que explica a consequência.
 *
 * Duas coisas que esta tela nunca faz:
 *   - apagar. "Remover" carimba `archived_at` (ver `archivePet`), porque
 *     `service_requests.pet_id` é `on delete restrict` e o histórico de quem
 *     cuidou de quem é prova, não enfeite.
 *   - falar com o Supabase. Foto, dados e arquivamento passam por
 *     `@/hooks/usePets`; o expo-image-picker aqui só escolhe o arquivo no
 *     aparelho, que é assunto do celular, não da camada de dados.
 */
import * as React from 'react'
import { ActivityIndicator, Alert, Image, Pressable, StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import * as ImagePicker from 'expo-image-picker'

import type { Pet } from '@/api/pets'
import {
  Body,
  Button,
  ErrorBanner,
  Loading,
  LongTextField,
  Screen,
  TextField,
  Title,
} from '@/components/ui'
import {
  useArchivePet,
  usePet,
  usePetPhoto,
  useUpdatePet,
  useUploadPetPhoto,
} from '@/hooks/usePets'
import { useTheme, type Theme } from '@/lib/theme'
import { descricaoDoPorte, petSchema, vacinaEstaVencida } from '@/schemas/pet'

type Especie = 'dog' | 'cat'
type Porte = 'small' | 'medium' | 'large'

/** O que a tela segura enquanto a pessoa digita. Tudo texto, como ela escreve. */
type Formulario = {
  nome: string
  especie: Especie
  porte: Porte | null
  raca: string
  /** Em DD/MM/AAAA — ver `paraISO`. */
  vacina: string
  observacoes: string
}

const ESPECIES: readonly { valor: Especie; titulo: string; detalhe: string }[] = [
  {
    valor: 'dog',
    titulo: 'Cachorro',
    detalhe: 'O serviço dele é o passeio: o passeador busca em casa e sai com ele na rua.',
  },
  {
    valor: 'cat',
    titulo: 'Gato',
    detalhe: 'O serviço dele é a visita em casa. Gato não passeia.',
  },
]

const PORTES: readonly Porte[] = ['small', 'medium', 'large']

/**
 * As mesmas opções do cadastro (app/(client)/pets/novo.tsx): `quality: 1`
 * porque quem encolhe a imagem é `uploadPetPhoto`, e o corte quadrado porque é
 * assim que a foto aparece no cartão da lista.
 */
const OPCOES_DA_FOTO: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'],
  allowsEditing: true,
  aspect: [1, 1],
  quality: 1,
}

export default function AnimalDoTutor(): React.JSX.Element {
  const router = useRouter()

  // O parâmetro da rota chega como texto, lista de textos ou nada — o expo-router
  // não promete mais que isso. Sem id não existe animal para buscar, e a tela cai
  // no mesmo lugar de um id que não é de ninguém.
  const params = useLocalSearchParams()
  const idDaRota = typeof params['id'] === 'string' ? params['id'] : null

  const consulta = usePet(idDaRota)

  function voltarParaLista(): void {
    // Quase sempre se chega aqui pela lista, e voltar preserva a rolagem dela.
    // O `replace` cobre quem abriu a tela por link ou por notificação.
    if (router.canGoBack()) router.back()
    else router.replace('/(client)/pets')
  }

  if (idDaRota === null) return <NaoEncontrado aoVoltar={voltarParaLista} />

  if (consulta.isError) {
    return (
      <Screen scroll>
        <Title>Não deu para abrir este animal</Title>
        <Body>
          O aplicativo não conseguiu buscar o cadastro agora. O que está salvo continua
          guardado — nada se perdeu.
        </Body>
        <ErrorBanner
          message={consulta.error?.message ?? 'Não foi possível falar com o servidor.'}
        />
        <Button
          label="Tentar de novo"
          onPress={() => void consulta.refetch()}
          loading={consulta.isFetching}
        />
        <Button label="Ver os meus animais" variant="ghost" onPress={voltarParaLista} />
      </Screen>
    )
  }

  if (consulta.isPending) {
    return (
      <Screen>
        <Loading />
      </Screen>
    )
  }

  const animal = consulta.data

  // A RLS não distingue "não existe" de "é de outra pessoa": as duas devolvem
  // nada. Para quem está lendo, o efeito é o mesmo, e a saída também.
  if (animal === null) return <NaoEncontrado aoVoltar={voltarParaLista} />

  if (animal.archived_at !== null) {
    return (
      <Screen scroll>
        <Title>{animal.name} não está mais na sua lista</Title>
        <Body>
          {dataCurta(animal.archived_at) === null
            ? `Você removeu ${animal.name} da sua lista.`
            : `Você removeu ${animal.name} em ${dataCurta(animal.archived_at)}.`}{' '}
          Os serviços que ele já recebeu continuam no seu histórico — nada foi apagado.
        </Body>
        <Body dim>
          Para pedir passeio ou visita para ele outra vez, cadastre o animal de novo.
        </Body>
        <Button label="Ver os meus animais" onPress={voltarParaLista} />
      </Screen>
    )
  }

  // A chave remonta o formulário quando a rota troca de animal. Sem ela, abrir
  // um segundo animal mostraria o que estava digitado no primeiro.
  return <Edicao key={animal.id} animal={animal} aoSair={voltarParaLista} />
}

function Edicao({ animal, aoSair }: { animal: Pet; aoSair: () => void }): React.JSX.Element {
  const s = useStyles()
  const theme = useTheme()

  const atualizar = useUpdatePet()
  const arquivar = useArchivePet()
  const enviarFoto = useUploadPetPhoto()

  const [form, setForm] = React.useState<Formulario>(() => doAnimal(animal))
  const [erros, setErros] = React.useState<Record<string, string>>({})
  const [erroDaFoto, setErroDaFoto] = React.useState<string | null>(null)

  // Mesma pergunta do cadastro: apagar o que estava escrito sobre o risco é um
  // ato, não um descuido de digitação, e quem cuida do animal vai ler o campo
  // vazio. Perguntada uma vez por visita à tela.
  const [riscoDeclarado, setRiscoDeclarado] = React.useState(false)

  // O aviso da vacina some sozinho quando a data entra — é o comportamento
  // certo, mas de dentro da tela parece que o aviso sumiu sem nada acontecer,
  // ainda mais quando a pessoa salvou pelo botão que fica dentro dele. Isto
  // guarda a boa notícia para o lugar onde o aviso estava.
  const [vacinaAcabouDeSerResolvida, setVacinaAcabouDeSerResolvida] = React.useState(false)

  /**
   * O aviso olha para o que está GRAVADO, não para o que está sendo digitado.
   * É o valor gravado que o trigger vai ler no pedido de serviço — e, como o
   * campo da vacina muda de lugar conforme o aviso, reagir a cada tecla tiraria
   * o teclado da pessoa no meio da data.
   */
  const vacinaPendente = vacinaEstaVencida(animal.rabies_valid_until)

  function alterar(mudanca: Partial<Formulario>): void {
    setForm((atual) => ({ ...atual, ...mudanca }))

    // "Salvo" e o erro do envio anterior falam do estado antigo. Deixá-los na
    // tela enquanto a pessoa mexe em outro campo faz o aviso parecer resposta
    // ao que ela acabou de digitar.
    if (atualizar.isSuccess || atualizar.isError) atualizar.reset()
    if (vacinaAcabouDeSerResolvida) setVacinaAcabouDeSerResolvida(false)
  }

  function salvar(): void {
    const resultado = petSchema.safeParse({
      name: form.nome,
      species: form.especie,
      size: form.porte,
      breed: form.raca,
      rabiesValidUntil: paraISO(form.vacina),
      riskNotes: form.observacoes,
    })

    if (!resultado.success) {
      setErros(errosPorCampo(resultado.error.issues))
      atualizar.reset()
      return
    }

    setErros({})

    // Tinha observação escrita e agora não tem mais: sem perguntar, o cadastro
    // passa a dizer "nada a declarar" sobre um animal que talvez morda, e nem o
    // tutor nem a plataforma ficam com registro de que a troca foi deliberada.
    const apagouORisco = animal.risk_notes !== null && resultado.data.riskNotes === null
    if (apagouORisco && !riscoDeclarado) {
      Alert.alert(
        `Apagar o que estava escrito sobre ${animal.name}?`,
        'Quem for cuidar dele passa a ver o cadastro sem aviso nenhum. Se ele morde, tem medo, está doente ou toma remédio e isso não estiver escrito, a responsabilidade por um acidente passa a ser sua — está nos Termos de Uso.',
        [
          { text: 'Manter o que está escrito', style: 'cancel' },
          {
            text: 'Apagar mesmo assim',
            style: 'destructive',
            onPress: () => {
              setRiscoDeclarado(true)
              enviar(resultado.data)
            },
          },
        ],
      )
      return
    }

    enviar(resultado.data)
  }

  function enviar(dados: Parameters<typeof atualizar.mutate>[0]['input']): void {
    const faltavaVacina = vacinaPendente
    atualizar.mutate(
      { id: animal.id, input: dados },
      {
        onSuccess: (salvo) => {
          setVacinaAcabouDeSerResolvida(
            faltavaVacina && !vacinaEstaVencida(salvo.rabies_valid_until),
          )
        },
      },
    )
  }

  /**
   * Arquivar é a única ação da tela que a pessoa não desfaz sozinha — não existe
   * "desarquivar" no aplicativo. Por isso a confirmação é do sistema, que ela não
   * fecha por engano com o dedo de passagem, e o texto diz o que fica e o que sai.
   */
  function confirmarRemocao(): void {
    Alert.alert(
      `Remover ${animal.name} da sua lista?`,
      `${animal.name} sai da lista e você não vai mais conseguir pedir passeio nem visita para ele. Não dá para desfazer: para tê-lo de volta na lista você teria que cadastrar tudo de novo. Os serviços que ele já recebeu continuam no seu histórico — nada do que você escreveu é apagado.`,
      [
        { text: 'Manter na lista', style: 'cancel' },
        {
          text: 'Remover',
          style: 'destructive',
          onPress: () => arquivar.mutate({ id: animal.id }, { onSuccess: aoSair }),
        },
      ],
      { cancelable: true },
    )
  }

  /**
   * Trocar a foto, pela câmera ou pelo que já está no aparelho.
   *
   * A permissão é pedida no toque do botão, e não na abertura da tela: quem
   * recebe um pedido de acesso à câmera sem ter pedido nada nega, e depois o
   * caminho passa a ser os ajustes do celular.
   */
  async function escolherFoto(origem: 'camera' | 'galeria'): Promise<void> {
    setErroDaFoto(null)
    enviarFoto.reset()

    try {
      const permissao =
        origem === 'camera'
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync()

      if (!permissao.granted) {
        // `canAskAgain` falso é o sistema avisando que não mostra mais o pedido:
        // insistir no botão não adianta, e mandar tentar de novo seria mentira.
        const comoLiberar = permissao.canAskAgain
          ? 'liberar o acesso e tentar de novo'
          : 'liberar o acesso nos ajustes do celular'

        setErroDaFoto(
          origem === 'camera'
            ? `O aplicativo não tem acesso à câmera. Você pode escolher uma foto que já está no aparelho, ou ${comoLiberar}.`
            : `O aplicativo não tem acesso às suas fotos. Você pode tirar uma foto na hora, ou ${comoLiberar}.`,
        )
        return
      }

      const escolha =
        origem === 'camera'
          ? await ImagePicker.launchCameraAsync(OPCOES_DA_FOTO)
          : await ImagePicker.launchImageLibraryAsync(OPCOES_DA_FOTO)

      if (escolha.canceled) return

      // Uma foto só (`selectionLimit` padrão), mas a lista é uma lista: ler o
      // primeiro item sem conferir seria um `!` disfarçado.
      const foto = escolha.assets[0]
      if (foto === undefined) return

      // Diferente do cadastro, aqui a foto sobe na hora: o animal já existe, e
      // guardar a escolha para um segundo botão só criaria mais uma coisa para
      // a pessoa lembrar de apertar.
      enviarFoto.mutate({ id: animal.id, localUri: foto.uri })
    } catch {
      setErroDaFoto(
        origem === 'camera'
          ? 'Não foi possível abrir a câmera. Tente de novo ou escolha uma foto que já está no aparelho.'
          : 'Não foi possível abrir as suas fotos. Tente de novo ou tire uma foto na hora.',
      )
    }
  }

  const campoDaVacina = (
    <TextField
      label="Validade da vacina antirrábica"
      value={form.vacina}
      onChangeText={(texto) => alterar({ vacina: mascaraDeData(texto) })}
      placeholder="DD/MM/AAAA"
      keyboard="numeric"
      error={erros['rabiesValidUntil']}
    />
  )

  const salvando = atualizar.isPending

  function temAlteracaoNaoSalva(): boolean {
    const gravado = doAnimal(animal)
    return (Object.keys(gravado) as (keyof Formulario)[]).some(
      (campo) => form[campo] !== gravado[campo],
    )
  }

  function tentarSair(): void {
    if (!temAlteracaoNaoSalva()) {
      aoSair()
      return
    }

    Alert.alert(
      'Sair sem salvar?',
      `Você mudou o cadastro de ${animal.name} e ainda não salvou. Se sair agora, a mudança se perde.`,
      [
        { text: 'Continuar aqui', style: 'cancel' },
        { text: 'Sair sem salvar', style: 'destructive', onPress: aoSair },
      ],
    )
  }

  return (
    <Screen scroll>
      <Title>{animal.name}</Title>
      {dataCurta(animal.created_at) !== null ? (
        <Text style={s.linhaDetalhe}>Cadastrado em {dataCurta(animal.created_at)}</Text>
      ) : null}

      <FotoDoAnimal animal={animal} />

      {/* A altura é fixa nos dois estados: a foto não pula na tela quando o
          envio começa, e o dedo que ia no botão não acerta outra coisa. */}
      <View style={s.fotoAcoes}>
        {enviarFoto.isPending ? (
          <View style={s.enviando} accessibilityLiveRegion="polite">
            <ActivityIndicator color={theme.colors.primary} />
            <Text style={s.enviandoTexto}>Enviando a foto…</Text>
          </View>
        ) : (
          <>
            <View style={s.fotoBotao}>
              <Button
                label="Tirar foto"
                variant="ghost"
                onPress={() => void escolherFoto('camera')}
              />
            </View>
            <View style={s.fotoBotao}>
              <Button
                label="Escolher foto"
                variant="ghost"
                onPress={() => void escolherFoto('galeria')}
              />
            </View>
          </>
        )}
      </View>

      {erroDaFoto !== null ? <ErrorBanner message={erroDaFoto} /> : null}
      {enviarFoto.error !== null ? <ErrorBanner message={enviarFoto.error.message} /> : null}

      {/* O aviso vermelho sumiu porque a data entrou. Sem esta linha, quem
          salvou pelo botão de dentro do aviso vê o bloco inteiro desaparecer e
          não tem como saber se salvou ou se a tela se perdeu. */}
      {vacinaAcabouDeSerResolvida ? (
        <View style={s.confirmacao} accessibilityLiveRegion="polite">
          <Text style={s.confirmacaoTexto}>
            Vacina em dia. Agora dá para pedir {animal.species === 'cat' ? 'visita' : 'passeio'}{' '}
            para {animal.name}.
          </Text>
        </View>
      ) : null}

      {vacinaPendente ? (
        <View style={s.alerta}>
          <Text style={s.alertaTitulo} accessibilityRole="header">
            {animal.rabies_valid_until === null
              ? 'Falta a vacina antirrábica'
              : 'A vacina antirrábica está vencida'}
          </Text>

          <Text style={s.alertaTexto}>
            {animal.rabies_valid_until === null
              ? `Enquanto a validade da antirrábica não estiver no cadastro, o aplicativo não deixa você pedir passeio nem visita para ${animal.name}.`
              : `A antirrábica de ${animal.name} venceu em ${deISO(animal.rabies_valid_until)}. Com ela vencida, o aplicativo não aceita pedido de passeio nem de visita.`}
          </Text>
          <Text style={s.alertaTexto}>
            É exigência dos Termos de Uso e vale para todo animal atendido — quem cuida dele
            também precisa estar protegido.
          </Text>
          <Text style={s.alertaTexto}>
            Pegue a carteirinha e procure a linha da antirrábica: a data que vai aqui é a da
            PRÓXIMA dose — às vezes vem escrito "revacinar em". Não é a data em que ele tomou
            a vacina, essa já passou. Se a antirrábica venceu mesmo, leve {animal.name} ao
            veterinário antes.
          </Text>

          {campoDaVacina}

          {/* O mesmo botão do fim da tela, de propósito: quem chegou aqui pelo
              aviso resolve a vacina sem sair procurando onde salvar. */}
          <Button label="Salvar alterações" onPress={salvar} loading={salvando} />
        </View>
      ) : null}

      <TextField
        label="Nome"
        value={form.nome}
        onChangeText={(nome) => alterar({ nome })}
        placeholder="O nome pelo qual ele atende"
        error={erros['name']}
      />

      <Text style={s.grupoTitulo} accessibilityRole="header">
        Cachorro ou gato
      </Text>

      <View style={s.grupo} accessibilityRole="radiogroup">
        {ESPECIES.map((opcao) => (
          <Escolha
            key={opcao.valor}
            titulo={opcao.titulo}
            detalhe={opcao.detalhe}
            escolhido={form.especie === opcao.valor}
            // O porte só existe para cão (constraint `dog_requires_size`), e o
            // que sobrou do outro caminho vira "gato de porte grande" na tela do
            // passeador. Trocar de espécie limpa o campo que não é mais dela.
            aoEscolher={() =>
              alterar({ especie: opcao.valor, porte: opcao.valor === 'cat' ? null : form.porte })
            }
          />
        ))}
      </View>

      {form.especie === 'cat' ? (
        <View style={s.aviso}>
          <Text style={s.avisoTitulo}>Gato não passeia</Text>
          <Text style={s.avisoTexto}>
            O serviço do gato é a visita em casa: o cuidador vai até você — comida, água, caixa
            de areia e um tempo de companhia. Ele não sai de casa, e por isso o porte não é
            perguntado.
          </Text>
        </View>
      ) : (
        <>
          <Text style={s.grupoTitulo} accessibilityRole="header">
            Porte
          </Text>
          <Text style={s.grupoAjuda}>
            É o porte que decide quem pode atender: passeador que não aceita cachorro grande não
            recebe o pedido.
          </Text>

          <View style={s.grupo} accessibilityRole="radiogroup">
            {PORTES.map((porte) => (
              <Escolha
                key={porte}
                titulo={descricaoDoPorte(porte)}
                escolhido={form.porte === porte}
                aoEscolher={() => alterar({ porte })}
              />
            ))}
          </View>

          <View style={s.erroVaga}>
            {erros['size'] !== undefined ? (
              <Text style={s.erroTexto} accessibilityLiveRegion="polite">
                {erros['size']}
              </Text>
            ) : null}
          </View>
        </>
      )}

      <TextField
        label="Raça"
        value={form.raca}
        onChangeText={(raca) => alterar({ raca })}
        placeholder="Se for vira-lata, pode deixar em branco"
        error={erros['breed']}
      />

      {vacinaPendente ? null : (
        <>
          {campoDaVacina}
          <Body dim>
            Na carteirinha, linha da antirrábica: vai aqui a data da PRÓXIMA dose, não a do dia
            em que ele tomou a vacina. Sem essa data em dia o aplicativo não aceita pedido de
            serviço.
          </Body>
        </>
      )}

      <Text style={s.grupoTitulo} accessibilityRole="header">
        O que quem cuidar dele precisa saber
      </Text>
      {/* O pedido de serviço guarda uma cópia destas observações (`pet_snapshot`,
          em assert_request_insert): o passeador lê o que estava escrito no dia,
          e não o que for corrigido depois. Por isso o texto pede a informação
          agora, e diz por que ela é pedida. */}
      <Text style={s.grupoAjuda}>
        Se ele morde ou já mordeu, se tem medo de moto ou de outros cães, se está doente, se
        toma remédio e a que horas. Quem vai cuidar do seu animal só sabe o que estiver escrito
        aqui, e o que valer no dia do pedido é o que ele vê. Se você não contar e acontecer um
        acidente, a responsabilidade pelo dano é sua (Termos de Uso).
      </Text>

      {/* Mesma caixa e mesma pergunta do cadastro. Aqui era um TextField de uma
          linha chamado "Observações" — rótulo genérico recebe resposta genérica,
          e o parágrafo rolava para o lado no único campo em que a pessoa precisa
          reler o que escreveu antes de salvar. */}
      <LongTextField
        label={
          form.especie === 'cat' ? 'Ele já arranhou ou mordeu alguém?' : 'Ele já mordeu alguém?'
        }
        help="Conte também se ele fica bravo com estranhos, tem medo de barulho, foge quando se assusta, toma algum remédio ou tem alguma doença."
        value={form.observacoes}
        onChangeText={(observacoes) => alterar({ observacoes })}
        placeholder={
          form.especie === 'cat'
            ? 'Ex.: se estranho tentar pegar no colo ele arranha. Toma remédio para o rim de manhã.'
            : 'Ex.: tem medo de moto e puxa muito a guia. Toma remédio para o coração às 8h.'
        }
        error={erros['riskNotes']}
      />

      {atualizar.error !== null ? <ErrorBanner message={atualizar.error.message} /> : null}

      {atualizar.isSuccess ? (
        <View style={s.confirmacao}>
          <Text style={s.confirmacaoTexto} accessibilityLiveRegion="polite">
            Alterações salvas.
          </Text>
        </View>
      ) : null}

      <Button label="Salvar alterações" onPress={salvar} loading={salvando} />

      <View style={s.divisor} />

      <Text style={s.grupoTitulo} accessibilityRole="header">
        Remover animal
      </Text>
      <Body dim>
        {animal.name} sai da sua lista e você deixa de pedir passeio e visita para ele. Os
        serviços que ele já recebeu ficam guardados no seu histórico: o aplicativo não apaga
        nada do que você cadastrou.
      </Body>
      {/* O comentário de `confirmarRemocao` já sabia disto; a tela é que não
          contava. Não existe "desarquivar" no aplicativo, e quem toca aqui
          esperando poder voltar atrás merece saber antes, não depois. */}
      <Body dim>
        Não dá para desfazer aqui: se você quiser {animal.name} de volta na lista, vai precisar
        cadastrar ele outra vez, com foto e tudo.
      </Body>

      {arquivar.error !== null ? <ErrorBanner message={arquivar.error.message} /> : null}

      <Button
        label="Remover da minha lista"
        variant="ghost"
        disabled={salvando}
        loading={arquivar.isPending}
        onPress={confirmarRemocao}
      />

      <View style={s.divisor} />

      {/* Era a única tela do épico sem saída desenhada: o _layout desliga o
          cabeçalho, então no iPhone sobrava o gesto de arrastar da borda. E
          sair com algo digitado perdia a alteração em silêncio. */}
      <Button
        label="Voltar para os meus animais"
        variant="ghost"
        disabled={salvando || arquivar.isPending}
        onPress={tentarSair}
      />
    </Screen>
  )
}

/**
 * A foto, do tamanho em que dá para reconhecer o animal.
 *
 * O bucket é privado: a URL é assinada e vence, por isso ela vem de uma consulta
 * e não da linha do animal. Quando a assinatura falha, `signPetPhotoUrl` devolve
 * null em vez de estourar — a foto é o enfeite do cadastro, e uma queda de rede
 * não pode derrubar a tela que mostra a vacina e as observações de risco.
 */
function FotoDoAnimal({ animal }: { animal: Pet }): React.JSX.Element {
  const s = useStyles()
  const foto = usePetPhoto(animal.photo_path)

  if (animal.photo_path === null) {
    return (
      <View style={[s.foto, s.fotoVazia]}>
        <Text style={s.fotoInicial}>{primeiraLetra(animal.name)}</Text>
        <Text style={s.fotoAviso}>Ainda sem foto</Text>
      </View>
    )
  }

  if (foto.isPending) {
    return (
      <View style={[s.foto, s.fotoVazia]} accessibilityLabel="Carregando a foto">
        <Text style={s.fotoAviso}>Carregando a foto…</Text>
      </View>
    )
  }

  const url = foto.data ?? null
  if (url === null) {
    return (
      <View style={[s.foto, s.fotoVazia]}>
        <Text style={s.fotoAviso}>
          Não foi possível carregar a foto agora. Verifique a internet — o cadastro continua
          salvo.
        </Text>
      </View>
    )
  }

  return (
    <Image
      source={{ uri: url }}
      style={s.foto}
      resizeMode="cover"
      accessible
      accessibilityRole="image"
      accessibilityLabel={`Foto de ${animal.name}`}
    />
  )
}

/**
 * Linha de escolha única. O alvo do toque é a linha inteira: o círculo tem 24pt
 * e o tutor mexe no app com o animal puxando a guia.
 */
function Escolha({
  titulo,
  detalhe,
  escolhido,
  aoEscolher,
}: {
  titulo: string
  detalhe?: string
  escolhido: boolean
  aoEscolher: () => void
}): React.JSX.Element {
  const s = useStyles()

  return (
    <Pressable
      onPress={aoEscolher}
      accessibilityRole="radio"
      accessibilityState={{ checked: escolhido }}
      accessibilityLabel={detalhe === undefined ? titulo : `${titulo}. ${detalhe}`}
      style={({ pressed }) => [s.linha, escolhido && s.linhaEscolhida, pressed && s.linhaPressionada]}
    >
      {/* A marca é desenho, não só cor: quem não distingue verde de cinza
          continua enxergando o que está escolhido. */}
      <View style={[s.marca, escolhido && s.marcaEscolhida]}>
        {escolhido ? <View style={s.marcaMiolo} /> : null}
      </View>

      <View style={s.linhaTexto}>
        <Text style={s.linhaTitulo}>{titulo}</Text>
        {detalhe === undefined ? null : <Text style={s.linhaDetalhe}>{detalhe}</Text>}
      </View>
    </Pressable>
  )
}

function NaoEncontrado({ aoVoltar }: { aoVoltar: () => void }): React.JSX.Element {
  return (
    <Screen scroll>
      <Title>Não encontramos esse animal</Title>
      <Body>
        Ou ele já foi removido da sua lista, ou o cadastro é de outra conta. Cada tutor enxerga
        só os animais que ele mesmo cadastrou.
      </Body>
      <Body dim>Volte para a sua lista e escolha um dos seus.</Body>
      <Button label="Ver os meus animais" onPress={aoVoltar} />
    </Screen>
  )
}

function doAnimal(animal: Pet): Formulario {
  return {
    nome: animal.name,
    especie: animal.species,
    porte: animal.size,
    raca: animal.breed ?? '',
    vacina: deISO(animal.rabies_valid_until),
    observacoes: animal.risk_notes ?? '',
  }
}

/**
 * A pessoa digita só os números e a tela põe as barras.
 *
 * Ninguém em Foz escreve 2027-03-12 numa carteirinha de vacinação, e o teclado
 * numérico não tem barra. Quem converte para o formato da coluna `date` é
 * `paraISO`, na hora de validar.
 */
function mascaraDeData(texto: string): string {
  const digitos = texto.replace(/\D/g, '').slice(0, 8)
  const dia = digitos.slice(0, 2)
  const mes = digitos.slice(2, 4)
  const ano = digitos.slice(4, 8)

  if (digitos.length <= 2) return dia
  if (digitos.length <= 4) return `${dia}/${mes}`
  return `${dia}/${mes}/${ano}`
}

/**
 * DD/MM/AAAA para o AAAA-MM-DD que a coluna guarda.
 *
 * Data pela metade volta como veio: quem diz que ela não serve é o esquema, com
 * a frase que a pessoa lê embaixo do campo — não uma conversão silenciosa que
 * inventa um dia qualquer.
 */
function paraISO(brasileira: string): string {
  const digitos = brasileira.replace(/\D/g, '')
  if (digitos.length !== 8) return brasileira.trim()

  return `${digitos.slice(4, 8)}-${digitos.slice(2, 4)}-${digitos.slice(0, 2)}`
}

/** O caminho de volta: AAAA-MM-DD para DD/MM/AAAA. */
function deISO(iso: string | null): string {
  if (iso === null) return ''

  const [ano, mes, dia] = iso.split('-')
  if (ano === undefined || mes === undefined || dia === undefined) return ''

  return `${dia}/${mes}/${ano}`
}

/** Data de `timestamptz` para leitura, no fuso do aparelho. */
/**
 * Devolve null — e não texto vazio — quando a data não converte: o chamador
 * interpola isto numa frase, e string vazia deixava 'Cadastrado em ' e 'Você
 * removeu Rex em .' na tela.
 */
function dataCurta(iso: string): string | null {
  const data = new Date(iso)
  if (Number.isNaN(data.getTime())) return null

  const dia = `${data.getDate()}`.padStart(2, '0')
  const mes = `${data.getMonth() + 1}`.padStart(2, '0')
  return `${dia}/${mes}/${data.getFullYear()}`
}

function primeiraLetra(nome: string): string {
  const limpo = nome.trim()
  return limpo === '' ? '?' : limpo.slice(0, 1).toUpperCase()
}

/**
 * A primeira mensagem de cada campo é a que fica: o esquema pode reprovar o
 * mesmo campo duas vezes, e a segunda frase só confundiria quem está lendo.
 */
function errosPorCampo(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): Record<string, string> {
  const mapa: Record<string, string> = {}

  for (const issue of issues) {
    const campo = issue.path[0]
    if (typeof campo !== 'string') continue
    mapa[campo] ??= issue.message
  }

  return mapa
}

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
    foto: {
      width: '100%',
      // Quadrada porque é assim que o recorte do picker entrega e que a lista
      // mostra depois: a mesma foto, sem corte novo a cada tela.
      aspectRatio: 1,
      borderRadius: radius.lg,
      backgroundColor: c.surfaceAlt,
    },
    fotoVazia: {
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      padding: spacing.lg,
      borderWidth: 2,
      borderStyle: 'dashed',
      borderColor: c.border,
    },
    fotoInicial: {
      color: c.textDim,
      fontSize: 72,
      lineHeight: 80,
      fontWeight: font.weight.bold,
    },
    fotoAviso: {
      color: c.textDim,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
      textAlign: 'center',
    },

    fotoAcoes: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      // A mesma altura do botão: trocar os botões pelo aviso de envio não mexe
      // no que está abaixo.
      minHeight: 48,
    },
    fotoBotao: { flex: 1 },
    enviando: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    enviandoTexto: {
      color: c.textDim,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
    },

    alerta: {
      backgroundColor: c.dangerSoft,
      borderLeftWidth: 4,
      borderLeftColor: c.danger,
      borderRadius: radius.sm,
      padding: spacing.md,
      gap: spacing.sm,
    },
    alertaTitulo: {
      color: c.danger,
      fontSize: font.size.md,
      lineHeight: font.line.md,
      fontWeight: font.weight.bold,
    },
    alertaTexto: {
      color: c.danger,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
    },

    aviso: {
      backgroundColor: c.accentSoft,
      borderLeftWidth: 4,
      borderLeftColor: c.accent,
      borderRadius: radius.sm,
      padding: spacing.md,
      gap: spacing.xs,
    },
    avisoTitulo: {
      color: c.accent,
      fontSize: font.size.md,
      lineHeight: font.line.md,
      fontWeight: font.weight.bold,
    },
    avisoTexto: {
      color: c.accent,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
    },

    grupoTitulo: {
      color: c.text,
      fontSize: font.size.md,
      lineHeight: font.line.md,
      fontWeight: font.weight.bold,
      marginTop: spacing.sm,
    },
    grupoAjuda: {
      color: c.textDim,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
    },
    grupo: { gap: spacing.sm },

    linha: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: 60,
      backgroundColor: c.surface,
      borderWidth: 2,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
    },
    linhaEscolhida: { borderColor: c.primary, backgroundColor: c.primarySoft },
    linhaPressionada: { borderColor: c.focus },
    linhaTexto: { flex: 1, gap: 2 },
    linhaTitulo: {
      color: c.text,
      fontSize: font.size.md,
      lineHeight: font.line.md,
      fontWeight: font.weight.medium,
    },
    linhaDetalhe: {
      color: c.textDim,
      fontSize: font.size.xs,
      lineHeight: font.line.xs,
    },

    marca: {
      width: 24,
      height: 24,
      borderRadius: radius.pill,
      borderWidth: 2,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    marcaEscolhida: { borderColor: c.primary },
    marcaMiolo: {
      width: 12,
      height: 12,
      borderRadius: radius.pill,
      backgroundColor: c.primary,
    },

    erroVaga: { minHeight: font.line.sm },
    erroTexto: {
      color: c.danger,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
      fontWeight: font.weight.medium,
    },

    confirmacao: {
      alignSelf: 'flex-start',
      backgroundColor: c.primarySoft,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
    },
    confirmacaoTexto: {
      color: c.primary,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
      fontWeight: font.weight.medium,
    },

    divisor: {
      height: 1,
      backgroundColor: c.divider,
      marginTop: spacing.lg,
    },
  })
}
