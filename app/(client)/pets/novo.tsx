/**
 * Cadastro de um animal do tutor.
 *
 * A ordem dos campos não é estética: a espécie vem primeiro porque é ela que
 * decide o resto — cão pede porte e vira passeio, gato não tem porte e vira
 * visita em casa (ADR decisão 1). Perguntar o nome antes faria a pessoa mudar
 * de ideia com o formulário já meio preenchido.
 *
 * Duas exigências do negócio moram aqui e não são detalhe de tela:
 *
 *   Vacina antirrábica (Termos §8) — o trigger `assert_request_insert` recusa o
 *   pedido de serviço sem ela em dia. Se o tutor só descobrir isso na hora de
 *   marcar o passeio, ele já escolheu data, já se organizou e leva um "não" do
 *   servidor. Por isso a explicação está embaixo do campo, no cadastro.
 *
 *   Observações de risco — omitir agressividade, medo, doença ou medicação
 *   transfere ao tutor a responsabilidade por dano a terceiros. Uma caixa
 *   chamada "observações" recebe "ele é um amor". A pergunta direta — "ele já
 *   mordeu alguém?" — recebe resposta.
 *
 * O animal é salvo primeiro e a foto depois, nesta ordem e nunca junto: o
 * caminho no bucket é montado com o id, que só existe depois do insert, e uma
 * falha de rede no meio do upload não pode levar junto o que a pessoa digitou.
 */
import * as React from 'react'
import {
  Alert,
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'
import * as ImagePicker from 'expo-image-picker'

import {
  Body,
  Button,
  ErrorBanner,
  LongTextField,
  Screen,
  TextField,
  Title,
} from '@/components/ui'
import { useCreatePet, useUploadPetPhoto } from '@/hooks/usePets'
import { useTheme, type Theme } from '@/lib/theme'
import { descricaoDoPorte, petSchema, vacinaEstaVencida } from '@/schemas/pet'

type Especie = 'dog' | 'cat'
type Porte = 'small' | 'medium' | 'large'

const ESPECIES: readonly { especie: Especie; titulo: string; detalhe: string }[] = [
  {
    especie: 'dog',
    titulo: 'Cachorro',
    detalhe: 'O serviço é o passeio: o passeador busca ele na sua casa e leva para a rua.',
  },
  {
    especie: 'cat',
    titulo: 'Gato',
    detalhe: 'O serviço é a visita em casa. O gato não sai.',
  },
]

const PORTES: readonly Porte[] = ['small', 'medium', 'large']

/**
 * `quality: 1` de propósito: quem encolhe e comprime a imagem é
 * `uploadPetPhoto` (src/api/storage.ts), com largura e qualidade pensadas para
 * o 4G. Comprimir aqui também faria a foto passar duas vezes pelo JPEG e
 * chegar borrada do mesmo tamanho.
 *
 * O corte quadrado é escolha do tutor, não do app: a foto aparece em cartão de
 * lista, e sem o corte o enquadramento vira um pedaço aleatório do retrato.
 */
const OPCOES_DA_FOTO: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'],
  allowsEditing: true,
  aspect: [1, 1],
  quality: 1,
}

export default function NovoAnimal(): React.JSX.Element {
  const router = useRouter()
  const s = useStyles()

  const criar = useCreatePet()
  const enviarFoto = useUploadPetPhoto()

  const [especie, setEspecie] = React.useState<Especie | null>(null)
  const [nome, setNome] = React.useState('')
  const [porte, setPorte] = React.useState<Porte | null>(null)
  const [raca, setRaca] = React.useState('')
  const [vacina, setVacina] = React.useState('')
  const [risco, setRisco] = React.useState('')
  const [fotoLocal, setFotoLocal] = React.useState<string | null>(null)
  const [erros, setErros] = React.useState<Record<string, string>>({})

  // O aviso da foto não é erro de formulário: permissão negada não impede
  // cadastrar o animal, e a mensagem morre assim que a pessoa tenta de novo.
  const [avisoDaFoto, setAvisoDaFoto] = React.useState<string | null>(null)
  const [permissaoTrancada, setPermissaoTrancada] = React.useState(false)

  // Quem já respondeu "não há nada a avisar" não é perguntado de novo a cada
  // toque. A pergunta serve para tirar o silêncio do meio do caminho, uma vez;
  // repeti-la viraria obstáculo, e obstáculo se aprende a contornar sem ler.
  const [riscoDeclarado, setRiscoDeclarado] = React.useState(false)

  function trocarEspecie(escolhida: Especie): void {
    setEspecie(escolhida)
    // Gato não tem porte. Guardar a escolha antiga não quebraria o banco —
    // `toColumns` zera o porte do gato — mas deixaria a marca de "grande" na
    // tela de quem acabou de dizer que tem um gato.
    if (escolhida === 'cat') setPorte(null)
  }

  function salvar(): void {
    const resultado = petSchema.safeParse({
      name: nome,
      species: especie,
      size: porte,
      breed: raca,
      // A coluna é `date` e espera 'AAAA-MM-DD'; a pessoa digita como está na
      // carteirinha. Data incompleta vai crua para o esquema de propósito —
      // é ele quem escreve a mensagem de data inválida, não esta tela.
      rabiesValidUntil: paraISO(vacina),
      riskNotes: risco,
    })

    if (!resultado.success) {
      setErros(errosPorCampo(resultado.error.issues))
      // Sem isto o erro do envio anterior fica na tela enquanto a pessoa
      // conserta um campo, e parece que o conserto não adiantou.
      criar.reset()
      return
    }

    setErros({})

    // Campo de risco em branco é ambíguo: pode ser "não tem nada a dizer" ou
    // "passei direto". Para quem vai buscar o animal a diferença é grande, e
    // para a plataforma também — o pet_snapshot guarda só o que estiver escrito
    // (item 33 de docs/auditoria-schema-v1.md), e sem a pergunta feita não há
    // como sustentar que a responsabilidade era do tutor. A pergunta transforma
    // o silêncio em resposta, sem travar o cadastro de quem não tem o que dizer.
    if (resultado.data.riskNotes === null && !riscoDeclarado) {
      Alert.alert(
        nome.trim() === '' ? 'Nada a avisar sobre ele?' : `Nada a avisar sobre ${nome.trim()}?`,
        'Quem for cuidar dele só vai saber o que estiver escrito aqui. Se ele morde, tem medo de barulho, foge, está doente ou toma remédio e isso não estiver no cadastro, a responsabilidade por um acidente passa a ser sua — está nos Termos de Uso.',
        [
          { text: 'Vou escrever agora', style: 'cancel' },
          {
            text: 'Não há nada a avisar',
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

  function enviar(dados: Parameters<typeof criar.mutate>[0]): void {
    criar.mutate(dados, {
      onSuccess: (animal) => {
        // A foto é o segundo passo, e só existe passo se houver foto escolhida.
        if (fotoLocal !== null) enviarFoto.mutate({ id: animal.id, localUri: fotoLocal })
      },
    })
  }

  async function escolherFoto(origem: 'camera' | 'galeria'): Promise<void> {
    setAvisoDaFoto(null)
    setPermissaoTrancada(false)

    // A permissão é pedida aqui, no toque, e não na abertura da tela: quem abre
    // um formulário de cadastro e leva um pedido de acesso à câmera na cara não
    // sabe por que está sendo perguntado, e nega.
    const permissao =
      origem === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync()

    if (!permissao.granted) {
      // `canAskAgain` falso é o sistema dizendo que não mostra mais o pedido.
      // Insistir no botão não adianta — o caminho passa a ser as configurações.
      setPermissaoTrancada(!permissao.canAskAgain)
      setAvisoDaFoto(
        origem === 'camera'
          ? 'O aplicativo não tem acesso à câmera. Você pode escolher uma foto da galeria, ou liberar a câmera e tentar de novo.'
          : 'O aplicativo não tem acesso às suas fotos. Você pode tirar uma foto na hora, ou liberar o acesso e tentar de novo.',
      )
      return
    }

    // Abrir a câmera é uma chamada ao sistema, e o sistema falha: câmera
    // ocupada por outro aplicativo, aplicativo de câmera do fabricante que
    // encerra sozinho, memória curta em Android de entrada. Sem este try o
    // erro sobe para a promessa solta do `void` e o toque no botão não faz
    // absolutamente nada visível — a pessoa toca de novo, e de novo.
    let escolha: ImagePicker.ImagePickerResult
    try {
      escolha =
        origem === 'camera'
          ? await ImagePicker.launchCameraAsync(OPCOES_DA_FOTO)
          : await ImagePicker.launchImageLibraryAsync(OPCOES_DA_FOTO)
    } catch {
      setAvisoDaFoto(
        origem === 'camera'
          ? 'Não foi possível abrir a câmera agora. Feche outros aplicativos que estejam usando a câmera e tente de novo, ou escolha uma foto da galeria.'
          : 'Não foi possível abrir suas fotos agora. Tente de novo, ou tire uma foto na hora.',
      )
      return
    }

    if (escolha.canceled) return

    // Uma foto só (`selectionLimit` padrão), mas a lista é uma lista: ler o
    // primeiro item sem conferir seria um `!` disfarçado.
    const foto = escolha.assets[0]
    if (foto === undefined) return

    setFotoLocal(foto.uri)
  }

  const animalSalvo = criar.data

  if (animalSalvo !== undefined) {
    return (
      <Confirmacao
        nome={animalSalvo.name}
        especie={animalSalvo.species === 'cat' ? 'cat' : 'dog'}
        vacinaEmDia={!vacinaEstaVencida(animalSalvo.rabies_valid_until)}
        fotoLocal={fotoLocal}
        // O estado da foto vem da mutação, não de `criar.data`: aquela linha é
        // a que o insert devolveu, de antes do upload, e o `photo_path` dela
        // continua vazio para sempre.
        fotoEnviada={enviarFoto.isSuccess}
        enviandoFoto={enviarFoto.isPending}
        erroDaFoto={enviarFoto.error?.message ?? null}
        aoTentarFotoDeNovo={() => {
          if (fotoLocal !== null) enviarFoto.mutate({ id: animalSalvo.id, localUri: fotoLocal })
        }}
        aoDesistirDaFoto={() => {
          enviarFoto.reset()
          setFotoLocal(null)
        }}
        aoConcluir={() => sair(router)}
      />
    )
  }

  const ehGato = especie === 'cat'
  const vacinaCompleta = somenteDigitos(vacina).length === 8
  const vacinaVencida = vacinaCompleta && vacinaEstaVencida(paraISO(vacina))

  return (
    <Screen scroll>
      <Title>Cadastrar um animal</Title>
      <Body dim>
        São estes dados que o passeador vê antes de aceitar o serviço e antes de chegar na
        sua porta.
      </Body>

      {criar.error !== null ? <ErrorBanner message={criar.error.message} /> : null}

      <Text style={s.grupoTitulo} accessibilityRole="header">
        É cachorro ou gato?
      </Text>

      <View style={s.grupo} accessibilityRole="radiogroup">
        {ESPECIES.map((opcao) => (
          <Escolha
            key={opcao.especie}
            titulo={opcao.titulo}
            detalhe={opcao.detalhe}
            escolhida={especie === opcao.especie}
            aoTocar={() => trocarEspecie(opcao.especie)}
          />
        ))}
      </View>

      <Vaga altura="sm">
        {erros['species'] !== undefined ? (
          <Text style={s.erroTexto} accessibilityLiveRegion="polite">
            {erros['species']}
          </Text>
        ) : null}
      </Vaga>

      {/* O aviso do gato aparece no momento da escolha, e não no fim do
          cadastro: quem procurou o app achando que alguém passeia com gato
          precisa saber disso antes de preencher o resto. */}
      {ehGato ? (
        <View style={s.aviso}>
          <Text style={s.avisoTitulo}>Gato não passeia</Text>
          <Text style={s.avisoTexto}>
            O serviço do gato é a visita em casa: a pessoa vai até você, cuida da comida, da
            água e da caixa de areia, e fica um tempo de companhia com ele. O gato não sai de
            casa em nenhum momento.
          </Text>
        </View>
      ) : null}

      <TextField
        label="Nome"
        value={nome}
        onChangeText={setNome}
        placeholder="Como você chama ele"
        error={erros['name']}
      />

      {especie === 'dog' ? (
        <>
          <Text style={s.grupoTitulo} accessibilityRole="header">
            Qual o porte dele?
          </Text>
          <Text style={s.grupoAjuda}>
            É o porte que decide quem pode atender: nem todo passeador aceita cachorro
            grande. Na dúvida, pense em levantar ele no colo.
          </Text>

          <View style={s.grupo} accessibilityRole="radiogroup">
            {PORTES.map((opcao) => (
              <Escolha
                key={opcao}
                // A descrição vem inteira de `descricaoDoPorte` — nome e faixa
                // de peso na mesma frase. Repetir "Pequeno" como título em cima
                // dela só faria a pessoa ler duas vezes a mesma palavra.
                titulo={descricaoDoPorte(opcao)}
                escolhida={porte === opcao}
                aoTocar={() => setPorte(opcao)}
              />
            ))}
          </View>

          <Vaga altura="sm">
            {erros['size'] !== undefined ? (
              <Text style={s.erroTexto} accessibilityLiveRegion="polite">
                {erros['size']}
              </Text>
            ) : null}
          </Vaga>
        </>
      ) : null}

      <TextField
        label="Raça (opcional)"
        value={raca}
        onChangeText={setRaca}
        placeholder={ehGato ? 'Siamês, persa, sem raça definida…' : 'Poodle, vira-lata, pitbull…'}
        error={erros['breed']}
      />
      <Body dim>Se você não souber, deixe em branco. Não faz falta nenhuma.</Body>

      <TextField
        label="Vacina antirrábica: até quando vale"
        value={vacina}
        // A máscara é aplicada a cada tecla porque o teclado é numérico e não
        // tem barra. Sem ela a pessoa digita 8 números seguidos e não consegue
        // conferir o que escreveu.
        onChangeText={(texto) => setVacina(mascaraDeData(texto))}
        placeholder="DD/MM/AAAA"
        keyboard="numeric"
        error={erros['rabiesValidUntil']}
      />

      {/* A frase mais importante da tela. Na carteirinha, o número que salta
          aos olhos é o dia da aplicação; o que o aplicativo quer é o da próxima
          dose. Quem digita o primeiro cai no aviso de data vencida com a vacina
          em dia, fica impedido de pedir serviço e não tem como descobrir por
          quê — e nada na tela contava a diferença. */}
      <Body dim>
        Na carteirinha, procure a linha da antirrábica e olhe a data da PRÓXIMA dose — às
        vezes vem escrito "revacinar em". Não é a data em que ele tomou a vacina: essa já
        passou, e o aplicativo vai entender como vencida.
      </Body>
      <Body dim>
        Sem a antirrábica em dia o aplicativo não deixa pedir passeio nem visita.
      </Body>
      <Body dim>
        Você pode cadastrar o animal agora e preencher essa data depois, quando tiver a
        carteirinha em mãos.
      </Body>

      {/* Vencida não trava o cadastro — trava o pedido de serviço. O lugar de
          descobrir isso é aqui, com tempo de marcar o veterinário, e não no dia
          em que a pessoa precisar sair e contar com o passeio. */}
      {vacinaVencida ? (
        <View style={s.aviso}>
          <Text style={s.avisoTitulo}>Essa data já passou</Text>
          <Text style={s.avisoTexto}>
            Confira na carteirinha: aqui vai a data da próxima dose, não a do dia em que ele
            tomou a vacina. Se a antirrábica venceu mesmo, pode cadastrar assim — só não dá
            para pedir passeio nem visita enquanto ela estiver vencida. Renove com o
            veterinário e volte aqui para atualizar a data.
          </Text>
        </View>
      ) : null}

      <LongTextField
        label={ehGato ? 'Ele já arranhou ou mordeu alguém?' : 'Ele já mordeu alguém?'}
        help="Conte também se ele fica bravo com estranhos, tem medo de barulho, foge quando se assusta, toma algum remédio ou tem alguma doença."
        value={risco}
        onChangeText={setRisco}
        placeholder={
          ehGato
            ? 'Ex.: se estranho tentar pegar no colo ele arranha. Toma remédio para o rim de manhã.'
            : 'Ex.: não gosta de outros cachorros e puxa muito a guia. Toma remédio para o coração às 8h.'
        }
        error={erros['riskNotes']}
      />

      <Body dim>
        Quem vai cuidar do seu animal precisa saber disso antes de chegar na sua porta — é o
        que permite a ele se preparar, ou dizer que não é o serviço dele. Se acontecer algo
        que você sabia e não contou aqui, a responsabilidade é sua: está nos Termos de Uso.
      </Body>

      <Text style={s.grupoTitulo} accessibilityRole="header">
        Foto (opcional)
      </Text>
      <Text style={s.grupoAjuda}>
        Ajuda o passeador a reconhecer o animal na hora de buscar. Dá para cadastrar sem
        foto e acrescentar depois.
      </Text>

      {fotoLocal !== null ? (
        <View style={s.fotoBloco}>
          <Image
            source={{ uri: fotoLocal }}
            style={s.foto}
            accessibilityRole="image"
            accessibilityLabel={nome === '' ? 'Foto escolhida' : `Foto escolhida de ${nome}`}
          />
          <Body dim>Esta foto sobe assim que o animal for cadastrado.</Body>
        </View>
      ) : null}

      <Button
        label={fotoLocal === null ? 'Tirar uma foto agora' : 'Tirar outra foto'}
        variant="ghost"
        disabled={criar.isPending}
        onPress={() => void escolherFoto('camera')}
      />
      <Button
        label={fotoLocal === null ? 'Escolher da galeria' : 'Escolher outra da galeria'}
        variant="ghost"
        disabled={criar.isPending}
        onPress={() => void escolherFoto('galeria')}
      />

      {fotoLocal !== null ? (
        <Button
          label="Não usar esta foto"
          variant="ghost"
          disabled={criar.isPending}
          // Nada foi enviado ainda: isto esquece o arquivo escolhido no
          // aparelho, não apaga foto nenhuma do servidor.
          onPress={() => setFotoLocal(null)}
        />
      ) : null}

      {avisoDaFoto !== null ? (
        <View style={s.aviso}>
          <Text style={s.avisoTexto} accessibilityLiveRegion="polite">
            {avisoDaFoto}
          </Text>
          {permissaoTrancada ? (
            <Button
              label="Abrir as configurações do aplicativo"
              variant="ghost"
              onPress={() => void Linking.openSettings()}
            />
          ) : null}
        </View>
      ) : null}

      {/* O formulário é longo e o botão fica no fim dele. Quando a validação
          reprova, as mensagens vão para os campos — que já rolaram para fora da
          tela. Quem toca aqui vê o botão parar de girar e nada mais acontecer.
          Este resumo põe o motivo ao lado do dedo que acabou de tocar. */}
      {Object.keys(erros).length > 0 ? (
        <View style={s.aviso} accessibilityLiveRegion="assertive">
          <Text style={s.avisoTitulo}>
            {Object.keys(erros).length === 1
              ? 'Falta uma coisa para cadastrar'
              : `Faltam ${Object.keys(erros).length} coisas para cadastrar`}
          </Text>
          {Object.values(erros).map((mensagem) => (
            <Text key={mensagem} style={s.avisoTexto}>
              • {mensagem}
            </Text>
          ))}
          <Text style={s.avisoTexto}>Role a tela para cima para corrigir.</Text>
        </View>
      ) : null}

      <Button label="Cadastrar o animal" onPress={salvar} loading={criar.isPending} />

      {/* Sem cabeçalho de navegação (o _layout desliga o header), este botão é a
          única saída visível da tela no iPhone além do gesto de arrastar. */}
      <Button
        label="Sair sem cadastrar"
        variant="ghost"
        disabled={criar.isPending}
        onPress={() => sair(router)}
      />
    </Screen>
  )
}

/**
 * O que aparece depois que o servidor aceitou o cadastro.
 *
 * Tela separada do formulário porque o assunto mudou: o animal já existe, e o
 * que resta é a foto — que pode estar subindo, ter falhado, ou nem existir.
 * Nenhum desses três casos desfaz o cadastro, e o texto diz isso em todos.
 */
function Confirmacao({
  nome,
  especie,
  vacinaEmDia,
  fotoLocal,
  fotoEnviada,
  enviandoFoto,
  erroDaFoto,
  aoTentarFotoDeNovo,
  aoDesistirDaFoto,
  aoConcluir,
}: {
  nome: string
  especie: Especie
  vacinaEmDia: boolean
  fotoLocal: string | null
  fotoEnviada: boolean
  enviandoFoto: boolean
  erroDaFoto: string | null
  aoTentarFotoDeNovo: () => void
  aoDesistirDaFoto: () => void
  aoConcluir: () => void
}): React.JSX.Element {
  const s = useStyles()

  return (
    <Screen scroll>
      <Title>{nome} está cadastrado</Title>

      <Body>
        {especie === 'cat'
          ? 'O serviço dele é a visita em casa: alguém vai até você cuidar dele, sem tirá-lo de casa.'
          : 'O serviço dele é o passeio: o passeador busca ele na sua casa e leva para a rua.'}
      </Body>

      {!vacinaEmDia ? (
        <View style={s.aviso}>
          <Text style={s.avisoTitulo}>Falta a vacina antirrábica em dia</Text>
          <Text style={s.avisoTexto}>
            O cadastro está salvo, mas para pedir {especie === 'cat' ? 'a visita' : 'o passeio'}{' '}
            é preciso ter a antirrábica válida. Assim que vacinar, informe a data no cadastro
            dele.
          </Text>
        </View>
      ) : null}

      {fotoLocal !== null ? (
        <View style={s.fotoBloco}>
          <Image
            source={{ uri: fotoLocal }}
            style={s.foto}
            accessibilityRole="image"
            accessibilityLabel={`Foto de ${nome}`}
          />
        </View>
      ) : null}

      {enviandoFoto ? (
        <Body dim>Enviando a foto. Isso pode levar alguns segundos.</Body>
      ) : null}

      {fotoEnviada && !enviandoFoto ? <Body dim>A foto foi enviada.</Body> : null}

      {/* O animal está salvo e a foto não. Dizer isso com todas as letras é o
          que impede a pessoa de cadastrar o mesmo animal de novo achando que
          nada foi gravado. */}
      {erroDaFoto !== null ? (
        <>
          <ErrorBanner message={erroDaFoto} />
          <Body>
            {nome} continua cadastrado — só a foto não subiu. Você pode tentar de novo agora
            ou acrescentar a foto outro dia, sem repetir o cadastro.
          </Body>
          <Button label="Tentar enviar a foto de novo" onPress={aoTentarFotoDeNovo} />
          <Button label="Continuar sem a foto" variant="ghost" onPress={aoDesistirDaFoto} />
        </>
      ) : null}

      {/* `loading` esconde o rótulo e bloqueia o toque (ui.tsx). Num 4G ruim o
          único botão da tela ficava cinza e mudo por vários segundos, sem dizer
          o que estava esperando. Sair agora também não é proibido: o animal já
          está salvo e o envio da foto continua até terminar. O botão segue
          bloqueado enquanto sobe — sair aqui perderia o aviso de falha do
          upload —, mas agora ele diz por que está bloqueado. */}
      <Button
        label={enviandoFoto ? 'Aguarde, enviando a foto…' : 'Concluir'}
        onPress={aoConcluir}
        disabled={enviandoFoto}
      />
    </Screen>
  )
}

/** Linha de escolha única. O alvo do toque é a linha inteira, não a bolinha. */
function Escolha({
  titulo,
  detalhe,
  escolhida,
  aoTocar,
}: {
  titulo: string
  detalhe?: string
  escolhida: boolean
  aoTocar: () => void
}): React.JSX.Element {
  const s = useStyles()

  return (
    <Pressable
      onPress={aoTocar}
      accessibilityRole="radio"
      accessibilityState={{ checked: escolhida }}
      accessibilityLabel={detalhe === undefined ? titulo : `${titulo}. ${detalhe}`}
      style={({ pressed }) => [s.linha, escolhida && s.linhaEscolhida, pressed && s.linhaPressionada]}
    >
      {/* A marca é um desenho, não só uma cor: quem não distingue verde de
          cinza continua vendo qual está escolhido. */}
      <View style={[s.marca, escolhida && s.marcaEscolhida]}>
        {escolhida ? <View style={s.marcaMiolo} /> : null}
      </View>

      <View style={s.linhaTexto}>
        <Text style={s.linhaTitulo}>{titulo}</Text>
        {detalhe !== undefined ? <Text style={s.linhaDetalhe}>{detalhe}</Text> : null}
      </View>
    </Pressable>
  )
}


/**
 * Espaço reservado para uma mensagem que pode ou não aparecer.
 *
 * Mesma regra dos componentes de '@/components/ui': nada muda de tamanho ao
 * mudar de estado. Um erro que empurra o formulário para baixo faz o dedo, já
 * a caminho, acertar o botão de baixo.
 */
function Vaga({
  altura,
  children,
}: {
  altura: 'xs' | 'sm'
  children: React.ReactNode
}): React.JSX.Element {
  const s = useStyles()
  return <View style={altura === 'xs' ? s.vagaXs : s.vagaSm}>{children}</View>
}

/** Volta para de onde veio, ou para a casa do tutor quando não há de onde voltar. */
function sair(router: ReturnType<typeof useRouter>): void {
  if (router.canGoBack()) {
    router.back()
    return
  }
  router.replace('/(client)/inicio')
}

function somenteDigitos(texto: string): string {
  return texto.replace(/[^0-9]/g, '')
}

/** 'DD/MM/AAAA' enquanto a pessoa digita, sem barra sobrando no fim. */
function mascaraDeData(texto: string): string {
  const digitos = somenteDigitos(texto).slice(0, 8)
  if (digitos.length <= 2) return digitos
  if (digitos.length <= 4) return `${digitos.slice(0, 2)}/${digitos.slice(2)}`
  return `${digitos.slice(0, 2)}/${digitos.slice(2, 4)}/${digitos.slice(4)}`
}

/**
 * 'DD/MM/AAAA' vira 'AAAA-MM-DD', que é o formato da coluna `date`.
 *
 * Data pela metade sai como a pessoa digitou, e não como null: null significa
 * "não informou" e passaria calado pelo esquema, deixando a vacina em branco
 * sem ninguém avisar. O texto cru é reprovado, com a mensagem certa embaixo do
 * campo. Se o dia ou o mês não existirem no calendário, quem reprova é
 * `petSchema` — esta função só reordena os pedaços.
 */
function paraISO(digitado: string): string {
  const digitos = somenteDigitos(digitado)
  if (digitos.length !== 8) return digitado.trim()
  return `${digitos.slice(4, 8)}-${digitos.slice(2, 4)}-${digitos.slice(0, 2)}`
}

/**
 * A primeira mensagem de cada campo é a que fica. O esquema pode reprovar o
 * mesmo campo duas vezes, e a segunda mensagem só confundiria quem está lendo.
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
      // A linha inteira é o alvo do toque; 60pt passa folgado dos 44 mínimos.
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

    aviso: {
      backgroundColor: c.accentSoft,
      borderLeftWidth: 4,
      borderLeftColor: c.accent,
      borderRadius: radius.sm,
      padding: spacing.md,
      gap: spacing.sm,
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

    vagaXs: { minHeight: font.line.xs },
    vagaSm: { minHeight: font.line.sm },
    erroTexto: {
      color: c.danger,
      fontSize: font.size.sm,
      lineHeight: font.line.sm,
      fontWeight: font.weight.medium,
    },


    fotoBloco: { gap: spacing.sm },
    foto: {
      width: 160,
      height: 160,
      borderRadius: radius.lg,
      // O fundo aparece enquanto a imagem carrega e atrás de PNG com
      // transparência — sem ele, um quadrado escuro no tema claro.
      backgroundColor: c.surfaceAlt,
    },
  })
}
