# Auditoria do schema v1.0

**Data:** 11/09/2026 · **Método:** quatro auditores independentes, cada achado submetido a dois céticos que tentaram refutá-lo.

**Resultado: a versão 1.0 foi reprovada e reescrita.** O arquivo `supabase/migrations/0001_schema.sql` hoje é a versão 2.0.

| Gravidade | Confirmados |
|---|---|
| Crítico | 28 |
| Alto | 33 |
| Médio | 22 |
| Baixo | 2 |
| **Total** | **85** |

Dois achados foram derrubados pelos céticos e não constam aqui.

---

## Crítico (28)

### 1. O cliente grava o próprio preço: INSERT direto em service_requests sem validação contra pricing

*Lente: Negócio*

**Problema.** A linha 7 do próprio arquivo diz "Regra de ouro: preço e comissão NUNCA vêm do app" e a Decisão 2 do ADR repete. Mas quem escreve price_cents, commission_cents, payout_cents e pricing_id é o INSERT do cliente. A policy de insert só valida `client_id = auth.uid() and my_role() = 'client'`. A única constraint é `split_fecha` (price = commission + payout), que qualquer trinca satisfaz. `current_pricing()` existe e nunca é chamada por nada no schema. Também não há coerência entre `pricing_id` e o par (service, duration_minutes) gravado na linha.

**Como quebra.** Tutor usa a anon key com um proxy (Decisão 6 do ADR prevê exatamente isso) e faz: insert into service_requests (..., price_cents, commission_cents, payout_cents, pricing_id, ...) values (..., 100, 20, 80, '<id do pricing de walk 60>', ...). `split_fecha` passa (100 = 20 + 80). O walker vê o pedido no feed e aceita achando que recebe R$ 32,00. A Edge Function gera o PIX a partir de `price_cents` = R$ 1,00 com application_fee de R$ 0,20. Walker faz o passeio por R$ 0,80.

### 2. O cliente pode se auto-confirmar sem pagar — exatamente o que a máquina de estados jura ser impossível

*Lente: Negócio*

**Problema.** maquina-de-estados.md diz: "→ confirmed | **ninguém no app** | Edge Function do webhook, service_role" e "confirmed nunca pode ser disparado pelo app. Se fosse, qualquer um confirmaria um serviço sem pagar". O trigger `assert_status_transition` valida **qual** transição, nunca **quem** a dispara. E a policy 428-429 dá UPDATE ao cliente em qualquer linha onde `client_id = auth.uid()`, sem restrição de coluna. Não existe nenhuma checagem de que há um `payments` aprovado antes de `confirmed`. O mesmo vale para `in_progress` e `completed`, que o cliente também pode disparar, e para `reserved`, onde o cliente pode inventar o `walker_id`.

**Como quebra.** Cliente cria o pedido, espera um walker aceitar (status = reserved). Em vez de pagar o PIX, roda pelo app/proxy: update service_requests set status = 'confirmed' where id = '...'. A transição reserved → confirmed está na lista permitida (linha 225), o trigger carimba `confirmed_at`, a notificação da linha 112 da maquina-de-estados dispara "Pagamento confirmado. O serviço está garantido" para o walker. O walker passeia. Ninguém pagou. Não existe linha em `payments`.

### 3. Policies de UPDATE sem WITH CHECK: cliente e walker reescrevem valor, walker_id, horário e reembolso

*Lente: Negócio*

**Problema.** As duas policies têm só `using (...)`. Em Postgres, UPDATE sem `with check` valida apenas a linha ANTIGA: a linha nova pode ser qualquer coisa. O trigger `trg_status_transition` é `before update **of status**` (linha 251) — um UPDATE que não toca `status` não passa por validação nenhuma. Nenhuma coluna de dinheiro é imutável. `refund_cents` e `final_payout_cents`, que a Decisão 4 do ADR diz existirem "para ficar auditável", são colunas que o próprio interessado escreve.

**Como quebra.** Cliente com serviço `completed` (R$ 40, walker recebeu R$ 32) roda: update service_requests set refund_cents = 4000, final_payout_cents = 0, cancel_reason = 'walker não compareceu' where id = '...'. Status não muda, nenhum trigger dispara, a auditoria do Épico 7 lê 40 de reembolso para um serviço executado. Variante do lado do walker: update service_requests set price_cents = 20000, commission_cents = 4000, payout_cents = 16000 where walker_id = auth.uid() and status = 'requested' — `split_fecha` passa e o PIX sai por R$ 200.

### 4. cancellation_split() é função órfã: nunca é chamada, e o resultado é escrito pelo app

*Lente: Negócio*

**Problema.** O ADR diz "Implementado em cancellation_split(), no banco — não na tela. O resultado é gravado em refund_cents e final_payout_cents". No schema, nada liga as duas pontas: não há trigger, default ou função de cancelamento que chame `cancellation_split`. Quem grava refund_cents é o app (ver achado anterior). Além disso o parâmetro `p_by` é `text` livre, não enum — 'no_show_client' escrito errado cai no `else`, que é o ramo de 50%. E não há constraint fechando a conta: nada garante `refund_cents + final_payout_cents + comissão_final = price_cents`.

**Como quebra.** Cliente cancela 10 minutos antes do passeio. O app (escrito pela mesma pessoa que está com 5h/semana) manda `refund_cents = 4000` porque o botão chamou o caminho errado. Nenhuma exceção. O walker, que já estava a caminho, recebe R$ 0 em vez dos R$ 16 da tabela da Decisão 4, e o cliente recebe R$ 40 num pedido em que a plataforma já devia ter retido R$ 4.

### 5. cancellation_split devolve dinheiro que nunca entrou (cancelamento em requested/reserved)

*Lente: Negócio*

**Problema.** A função só olha `scheduled_at - now()` e `p_by`. Nunca olha `p_request.status` nem se existe `payments` aprovado. Mas as transições `requested → cancelled_client` e `reserved → cancelled_client/cancelled_walker` são válidas, e nesses dois estados o PIX ainda não foi pago — por construção, a Decisão 3 do ADR é "walker aceita primeiro, cliente paga depois". Resultado: um cancelamento antes do pagamento produz `refund_cents = 4000` sobre R$ 0 recebidos.

**Como quebra.** Cliente cria pedido para daqui a 3 horas, walker aceita, status = reserved, o PIX é gerado e não é pago. Cliente clica em cancelar. A função cai na linha 268 (`p_by='client' and horas >= 2`) e devolve (4000, 0). O app grava refund_cents = 4000. O relatório de repasse do Épico 7 e a conciliação com o extrato do Mercado Pago acusam R$ 40,00 de estorno sem pagamento correspondente. Multiplicado pelas expirações, que são o caso mais comum do sistema, a conciliação fica impossível de fechar.

### 6. A comissão final não existe em nenhuma coluna — e a NF é sobre a comissão

*Lente: Negócio*

**Problema.** Com a decisão do dono de 11/09/2026 (nota fiscal sobre os R$ 8,00 de comissão), a base de cálculo da NFS-e é a receita da plataforma naquele serviço. O schema guarda a comissão **prevista** (`commission_cents`, snapshot do pedido) e, no cancelamento, guarda só `refund_cents` e `final_payout_cents` — a comissão efetivamente retida é uma subtração implícita que ninguém armazena e nenhuma constraint fecha. No cancelamento de menos de 2h, a conta é 4000 − 2000 − 1600 = 400: a plataforma reteve R$ 4,00, não R$ 8,00. Não existe coluna que diga isso.

**Como quebra.** Mês fecha com 100 serviços: 90 completos (R$ 8 cada) e 10 cancelados com menos de 2h (R$ 4 cada). A base fiscal real é 90×8 + 10×4 = R$ 760,00. Qualquer relatório que o dono consiga extrair do schema atual soma `commission_cents` e informa R$ 800,00, ou soma só os completos e informa R$ 720,00. As duas respostas estão erradas e ele emite NFS-e sobre um valor que não bate com o extrato do Mercado Pago.

### 7. O walker limpa a própria suspensão e se auto-verifica — a suspensão por nota baixa (Termos §14) é inaplicável

*Lente: Negócio*

**Problema.** A policy é `for all using (user_id = auth.uid()) with check (user_id = auth.uid())` — sem restrição de coluna. O walker pode dar UPDATE em `suspended_at`, `verified_at`, `rating_avg` e `rating_count` do próprio registro. `walkers_for_request()` filtra por `wp.suspended_at is null`, então zerar essa coluna é o bastante para voltar ao pool. Somado a isso: nada, em lugar nenhum do schema, **escreve** `suspended_at`. Não há trigger sobre `rating_avg`, não há limiar, não há tabela de suspensões com motivo, prazo e quem aplicou. A regra dos Termos §14 (suspensão por nota baixa) não tem mecanismo nem ponto de partida — e, se tivesse, o suspenso a desfaz com um UPDATE.

**Como quebra.** Walker acumula média 2,1 em 12 avaliações. O suporte (o próprio dono) atualiza `suspended_at = now()`. O walker abre o app, que já faz update em walker_profiles para salvar bio e raio, e o mesmo endpoint aceita `suspended_at: null`. Ele volta ao pool no mesmo minuto, e ainda pode mandar `verified_at: now()` e `rating_avg: 5.00`, contornando a verificação de documento que o ADR (linha 185-186) descreve como feita à mão.

### 8. Qualquer usuário muda o próprio role para 'walker' ou 'admin'

*Lente: Negócio*

**Problema.** A policy de UPDATE em `profiles` não restringe colunas. `role` é editável pelo dono da linha. `my_role()` é usada em policies (linhas 426 e 434) e é `security definer` sem `set search_path`. O enum tem 'admin' (linha 17), que hoje não abre nada — mas qualquer policy futura de suporte que teste `my_role() = 'admin'` nasce furada.

**Como quebra.** Tutor roda: update profiles set role = 'walker' where id = auth.uid(). O trigger `trg_walker_cpf` exige CPF de 11 dígitos — ele informa um CPF qualquer com 11 dígitos (o trigger só conta dígitos, não valida dígito verificador). Agora ele lê todos os pedidos abertos da cidade via policy da linha 431-435, com endereço completo (`address_text`) e horário de todas as casas com animal em Foz do Iguaçu. É vazamento de endereço residencial em massa, contra a Decisão 6 do ADR ("Localização de pessoa não vaza").

### 9. A máquina de estados só existe no UPDATE — o INSERT entra com qualquer status

*Lente: Postgres*

**Problema.** trg_status_transition é `before update of status`. Não existe nenhum trigger BEFORE INSERT em service_requests. O `default 'requested'` da linha 155 é só um default: se o cliente mandar a coluna, o default não se aplica. A policy de insert valida apenas `client_id = auth.uid() and my_role() = 'client'` — não valida status, nem carimbos, nem valores financeiros.

**Como quebra.** O tutor (ou qualquer proxy apontado para a API) faz POST /rest/v1/service_requests com {"client_id": <ele mesmo>, "status": "completed", "completed_at": "2026-09-11T10:00:00Z", "final_payout_cents": 3200, "walker_id": <ele mesmo>, ...}. A linha nasce concluída: nunca passou por reserved, nunca teve pagamento, e já habilita review (assert_review_completed só olha status='completed') e repasse do Épico 7. Nenhuma exceção é levantada em lugar nenhum.

### 10. Preço, comissão e repasse chegam do app — a regra de ouro do ADR não é imposta por nada

*Lente: Postgres*

**Problema.** O cabeçalho do arquivo diz 'preço e comissão NUNCA vêm do app'. No schema como está, eles vêm exatamente do app: o cliente informa pricing_id, price_cents, commission_cents e payout_cents no INSERT. A única barreira é `split_fecha check (price_cents = commission_cents + payout_cents)`, que é satisfeita por qualquer tripla coerente. Também não há vínculo entre `duration_minutes` da solicitação e o `duration_minutes` da linha de pricing referenciada.

**Como quebra.** POST com {"price_cents": 100, "commission_cents": 20, "payout_cents": 80, "pricing_id": <o id real de 4000>}. split_fecha fecha (100 = 20 + 80). O serviço de R$ 40,00 vira R$ 1,00, o QR do PIX é gerado em cima de price_cents e a comissão da plataforma vira R$ 0,20. Não existe nenhum CHECK, trigger ou policy que compare price_cents com pricing.price_cents.

### 11. RLS de UPDATE é de linha inteira: o cliente confirma sem pagar e o walker reescreve o próprio repasse

*Lente: Postgres*

**Problema.** Ambas as policies liberam UPDATE em TODAS as colunas da linha. Não há grant por coluna nem trigger de congelamento. O trigger de transição só reprova caminhos inválidos — reserved→confirmed é um caminho VÁLIDO, então ele aprova. O documento docs/maquina-de-estados.md diz 'confirmed nunca pode ser disparado pelo app', mas isso não está implementado em lugar nenhum do banco.

**Como quebra.** (a) Pedido em 'reserved'. O walker (ou o cliente) faz PATCH /rest/v1/service_requests?id=eq.X com {"status":"confirmed"}. O trigger aprova, confirmed_at é carimbado, o serviço fica garantido e nenhum PIX foi pago. (b) PATCH {"commission_cents": 0, "payout_cents": 4000} — split_fecha continua verdadeira (4000 = 0 + 4000) e o Épico 7 repassa R$ 40,00 ao walker, com comissão zero. (c) PATCH {"price_cents": 100000} antes de gerar o QR.

### 12. O aceite do walker é impossível: a policy de UPDATE exige walker_id = auth.uid() numa linha em que walker_id ainda é NULL

*Lente: Postgres*

**Problema.** A cláusula USING de uma policy de UPDATE é avaliada sobre a linha ANTIGA. Um pedido em 'requested' tem walker_id NULL (linha 151, coluna nullable). NULL = auth.uid() avalia para NULL, que não é TRUE, logo a linha é invisível para o UPDATE. A transição requested → reserved, que é o coração do produto (decisão 3 do ADR), não pode ser executada por nenhum walker pelo app.

**Como quebra.** Walker abre a lista, toca em 'Aceitar'. O app faz PATCH ?id=eq.X com {"walker_id": <ele>, "status": "reserved"}. PostgREST devolve 204 com zero linhas afetadas (ou [] com Prefer: return=representation). Nenhum erro, nenhuma exceção do trigger. O walker acha que aceitou, o cliente nunca recebe o push de 'Fulano aceitou', o pedido fica em requested para sempre. Falha silenciosa no caminho principal.

### 13. walkers_for_request() devolve zero linhas sempre — o Épico 4 nasce morto

*Lente: Postgres*

**Problema.** A função não é SECURITY DEFINER, logo roda com os privilégios e o contexto RLS de quem a chama. walker_locations tem RLS habilitada (linha 390) e a única policy existente restringe a leitura ao próprio walker. Quando o cliente chama a função, o join `join walker_locations wl on wl.available` é filtrado pela RLS e não retorna nenhuma linha. O comentário da linha 458 ('Clientes NÃO leem esta tabela direto: usam walkers_for_request()') descreve uma intenção que o SQL não implementa.

**Como quebra.** Cliente cria o pedido e o app chama POST /rest/v1/rpc/walkers_for_request. Retorno: []. A tela mostra 'nenhum passeador disponível na sua região'. Não há erro, não há log, e o diagnóstico natural é 'faltam walkers cadastrados' — quando na verdade a função nunca conseguiria ver nem um. Como o Épico 4 vem depois do 5, isso só apareceria no mês 5 ou 6.

### 14. refresh_walker_rating() explode no DELETE e nunca grava nada no INSERT

*Lente: Postgres*

**Problema.** Dois defeitos independentes na mesma função. (1) O trigger cobre DELETE, mas o corpo referencia `new.walker_id` (linhas 341 e 342). Em trigger de DELETE o registro NEW não é atribuído — PL/pgSQL levanta 'record "new" is not assigned yet' (SQLSTATE 55000). (2) A função não é SECURITY DEFINER, então o UPDATE em walker_profiles roda com o contexto RLS de quem inseriu a review — o cliente. A policy da linha 406-407 exige user_id = auth.uid(), que é o walker, não o cliente: o UPDATE casa zero linhas e não levanta erro nenhum. Além disso, um UPDATE que troque walker_id deixa o agregado do walker antigo desatualizado.

**Como quebra.** (a) Cliente pede exclusão de conta (LGPD). `delete from auth.users` cascateia para profiles, que cascateia para reviews (linha 310-311), que dispara o trigger de DELETE e aborta a transação inteira com 55000. Nenhum usuário consegue ser excluído do sistema. (b) Fluxo normal do Épico 8: cliente avalia com 5 estrelas, o INSERT passa, o trigger roda, o UPDATE afeta 0 linhas, rating_avg fica NULL e rating_count fica 0 para todos os walkers, para sempre. A lista de walkers nunca mostra nota.

### 15. O app escreve o próprio preço — a 'regra de ouro' do arquivo é falsa

*Lente: Segurança*

**Problema.** O comentário da linha 7 diz 'preço e comissão NUNCA vêm do app' e o ADR decisão 2 repete isso. Mas a policy de INSERT só exige `client_id = auth.uid() and my_role() = 'client'` — não valida price_cents, commission_cents, payout_cents nem pricing_id contra current_pricing(). A policy de UPDATE só exige `client_id = auth.uid()`, sem WITH CHECK de coluna (RLS não tem granularidade de coluna; quem tem é o GRANT). A única defesa é a constraint `split_fecha`, que exige price = commission + payout — e o atacante controla os três números, então ela sempre fecha.

**Como quebra.** 1) O atacante extrai a anon key do APK (está embutida, é pública por design) e pega o próprio JWT do app. 2) POST /rest/v1/service_requests com `{"pet_id":"<meu pet>","service":"walk","duration_minutes":60,"price_cents":100,"commission_cents":20,"payout_cents":80,"pricing_id":"<id vigente, lido de /rest/v1/pricing que é público>", ...}`. split_fecha passa (100 = 20 + 80). 3) A Edge Function do Épico 5 gera o PIX lendo o snapshot da linha — é para isso que o snapshot existe — e cobra R$ 1,00 com application_fee de R$ 0,20. 4) O walker passeia por R$ 0,80 e a plataforma ganha R$ 0,20. Variante do walker: depois de aceitar, PATCH /rest/v1/service_requests?id=eq.X com `{"price_cents":4000,"commission_cents":0,"payout_cents":4000}` — o walker fica com os R$ 40 inteiros e a comissão some. Nenhum log registra: não existe trigger touch_updated_at em service_requests (os triggers t1..t4, L494-497, cobrem só profiles, walker_profiles, pets e payments), então nem updated_at muda.

### 16. O status inicial é livre no INSERT — dá para nascer 'confirmed' ou 'completed' sem pagar nada

*Lente: Segurança*

**Problema.** A máquina de estados inteira é aplicada por um trigger `before update of status`. Em INSERT ele não roda. Não existe constraint dizendo que uma solicitação nasce em 'requested'. `default 'requested'` é apenas um default — o cliente sobrescreve. A constraint `reserva_tem_walker` (L189) só olha o caso 'reserved'; 'confirmed', 'in_progress' e 'completed' passam sem nenhuma verificação. E `walker_id` também é livre no insert: o cliente escolhe qual walker aparece na linha.

**Como quebra.** 1) GET /rest/v1/walker_profiles?select=user_id (a policy L404-405 é `using (true)`) devolve o uuid de todos os walkers. 2) POST /rest/v1/service_requests com `{"client_id":"<eu>","pet_id":"<meu>","walker_id":"<uuid de um walker qualquer>","service":"walk","duration_minutes":60,"status":"completed","completed_at":"2026-09-11T10:00:00Z","price_cents":4000,"commission_cents":800,"payout_cents":3200,"terms_version":"v1.0","terms_accepted_at":"now()", ...}`. 3) A linha entra direto como serviço concluído, sem walker ter aceitado, sem PIX, sem uma única linha em `payments`. 4) Agora o trigger `assert_review_completed` (L320-331) encontra status = 'completed' e libera a avaliação — o atacante insere uma review 1 estrela contra aquele walker (ver achado das reviews). 5) Pior: o Épico 7 (comissão e repasse) vai processar `final_payout_cents` de serviços 'completed'; qualquer relatório financeiro passa a contar serviços que nunca existiram.

### 17. 'confirmed' é alcançável pelo app — o documento afirma que é impossível, o schema permite

*Lente: Segurança*

**Problema.** maquina-de-estados.md diz literalmente: '→ confirmed | **ninguém no app** | Edge Function do webhook, service_role' e 'confirmed nunca pode ser disparado pelo app. Se fosse, qualquer um confirmaria um serviço sem pagar'. O schema não implementa isso em lugar nenhum. O trigger `assert_status_transition` aceita `reserved -> confirmed` sem olhar a tabela `payments`, e a RLS dá UPDATE ao cliente e ao walker sobre a própria linha. A única coisa que separa um serviço pago de um não pago é a Edge Function — ou seja, a regra existe só na tela, exatamente o que a decisão 6 do ADR proíbe.

**Como quebra.** 1) Cliente cria o pedido normalmente pelo app. 2) Um walker aceita — a linha vai para 'reserved' com reserved_until = agora + 10 min. 3) Em vez de abrir o app do banco, o atacante manda PATCH /rest/v1/service_requests?id=eq.<X> com `{"status":"confirmed"}` pelo proxy. 4) O trigger valida reserved → confirmed: permitido. Carimba confirmed_at = now(). 5) O walker recebe o push 'Pagamento confirmado. O serviço está garantido.' (maquina-de-estados.md L112), vai até a casa, faz o passeio, marca in_progress e completed. 6) Não existe nenhuma linha em `payments` com status 'approved'. O walker trabalhou de graça, a plataforma não tem comissão, e quem descobre é o walker no fim do mês. Numa cidade com 5 walkers, dois casos desses e a oferta acaba.

### 18. Qualquer usuário vira walker ou admin com um PATCH na própria linha de profiles

*Lente: Segurança*

**Problema.** `for update using (id = auth.uid()) with check (id = auth.uid())` autoriza o usuário a atualizar **toda** a linha, inclusive `role`. RLS no Postgres não filtra coluna — quem filtra é o GRANT, e o Supabase concede por padrão `UPDATE` sobre todas as tabelas do schema public para `authenticated`. O único obstáculo é o trigger de CPF, que aceita quaisquer 11 dígitos: `length(regexp_replace(cpf,'\D','','g')) <> 11` não valida dígito verificador, então '11111111111' passa.

**Como quebra.** 1) Usuário se cadastra como cliente normal, pega o JWT. 2) PATCH /rest/v1/profiles?id=eq.<meu_uuid> com `{"role":"walker","cpf":"11111111111"}` — 200 OK. 3) Agora `my_role()` devolve 'walker' e a policy L431-435 libera SELECT de **todas** as solicitações com status 'requested' da cidade inteira: address_text (endereço residencial completo), address_geog (coordenada exata), scheduled_at (a hora exata em que o tutor estará na rua ou esperando alguém) e client_id. 4) Um loop com `?status=eq.requested&select=*&limit=1000` a cada minuto monta, em semanas, um cadastro de endereços de Foz com horário — insumo de furto residencial, não abstração. 5) Se quiser, `{"role":"admin"}` também passa: hoje 'admin' não tem policy, mas o enum existe (L17) e a primeira policy de admin que alguém escrever passa a valer para quem se autopromoveu. 6) Volta para 'client' com outro PATCH quando quiser criar pedidos de novo (a policy de insert exige my_role() = 'client'). O papel é um campo de formulário.

### 19. walker_profiles é 'FOR ALL': o walker suspenso se dessuspende, se autoverifica e forja a própria nota

*Lente: Segurança*

**Problema.** `for all` cobre INSERT, UPDATE, SELECT e DELETE, sobre a linha inteira, sem nenhuma checagem de papel. A policy confunde 'a linha é minha' com 'eu posso escrever o que quiser nela'. Quatro colunas que só a plataforma deveria escrever estão expostas: `verified_at` (o selo de documento conferido — o ADR diz explicitamente que é preenchido à mão), `suspended_at` (a única sanção que existe no sistema), `rating_avg`/`rating_count` (a reputação), e `mp_user_id` (a conta que recebe o split). Não há nem exigência de que o usuário tenha role = 'walker'.

**Como quebra.** Ataque A — desfazer a suspensão: 1) Um walker se envolve num incidente com um animal e você preenche `suspended_at`. Ele some de `walkers_for_request()` por causa do filtro `wp.suspended_at is null` (L373). 2) Ele abre o proxy e manda PATCH /rest/v1/walker_profiles?user_id=eq.<ele> com `{"suspended_at":null}`. 3) Volta ao pool na mesma hora. Você só descobre no próximo incidente — não há audit log em lugar nenhum do schema.

Ataque B — selo e nota falsos: PATCH com `{"verified_at":"2026-01-10T00:00:00Z","rating_avg":5.00,"rating_count":143}`. O app mostra 'verificado, 5,0 (143 avaliações)' para um walker que nunca entregou um documento e nunca fez um serviço. Com 5 walkers reais na cidade, ele fica no topo de qualquer ordenação.

Ataque C — cliente vira walker sem tocar em profiles.role: POST /rest/v1/walker_profiles com `{"user_id":"<meu uuid de cliente>","accepts_dog":true,"verified_at":"now()","mp_user_id":"..."}`, depois POST /rest/v1/walker_locations com `{"walker_id":"<eu>","geog":"POINT(-54.58 -25.51)","available":true}` (a policy L456-457 também é `for all`, e a FK aponta para `profiles`, não para `walker_profiles`). Pronto: ele entra no resultado de `walkers_for_request()` e passa a receber o push com o endereço dos pedidos. É um segundo caminho de escalonamento, independente do da coluna role.

### 20. walkers_for_request devolve distância exata: trilateração da posição de pessoas com três pedidos falsos

*Lente: Segurança*

**Problema.** O ADR afirma: 'walker_locations não é legível por clientes. Eles chamam walkers_for_request(), que devolve distância, nunca coordenada. Localização de pessoa não vaza.' Distância a partir de três pontos que o atacante escolhe **é** a coordenada — é trilateração, o método de posicionamento do próprio GPS. A função devolve `distance_m double precision` (precisão sub-métrica) junto com o `walker_id`, o que torna o resultado nominal: não é 'alguém está a 412 m', é 'a walker Fulana está a 412,7 m deste ponto'. Dois agravantes: (a) a função não é SECURITY DEFINER, então hoje ela roda com RLS do chamador e devolve **zero linhas** para qualquer cliente — o Épico 4 não funciona, e a correção óbvia é marcá-la definer, que é justamente o que abre o rastreador; (b) ela não verifica que o request pertence a quem chama, nem que está em 'requested'.

**Como quebra.** 1) O atacante cria três pedidos com endereços que ele mesmo escolhe — `address_geog` vem do app (L160), ninguém valida que a coordenada corresponde ao address_text nem que o atacante mora lá. Ele escolhe três pontos afastados em Foz: Vila A, Centro, Jardim São Paulo. 2) POST /rest/v1/rpc/walkers_for_request com cada um dos três request_id. 3) Recebe, para cada walker, três distâncias exatas. 4) Três círculos, uma interseção: a posição de cada walker com erro de poucos metros, em tempo real, atualizada a cada chamada (walker_locations.updated_at, L358, é sobrescrita continuamente). 5) Como `available` só é ligado quando o walker está trabalhando, o atacante sabe não só onde ela está, mas que ela está na rua, sozinha, provavelmente a pé, e quanto tempo até o próximo ponto. Isso não é vazamento de dado, é localização de pessoa física — e o público-alvo de walker em Foz é majoritariamente feminino. Numa base de ~5 walkers, é perseguição individualizada. Custo do ataque: três POSTs.

### 21. Nenhum walker consegue aceitar um pedido — a policy de UPDATE compara walker_id NULL

*Lente: Operação*

**Problema.** Num pedido em 'requested', walker_id é NULL. NULL = auth.uid() avalia como NULL, que a RLS trata como falso. Não existe nenhuma outra policy de UPDATE que alcance um walker. Portanto a transição requested -> reserved, que é o coração do produto, é inalcançável pelo app. O schema está internamente contraditório: maquina-de-estados.md linha 59 diz que essa transição roda no app com RLS walker_id = auth.uid(), mas nesse instante o walker_id ainda não existe.

**Como quebra.** Walker toca Aceitar. O app roda update service_requests set status='reserved', walker_id=auth.uid() where id=X and status='requested'. Retorna 0 linhas, sem erro. Pelo próprio manual (maquina-de-estados.md, linha 128), 0 linhas significa 'outro walker já assumiu' — então 100% dos aceites mostram a mensagem errada e nenhum pedido sai de requested. Não aparece em teste com service_role (bypassa RLS); só quebra com dois logins reais, depois do épico 3 pronto.

### 22. O cliente confirma o próprio serviço sem pagar e reescreve o próprio preço

*Lente: Operação*

**Problema.** for update using (client_id = auth.uid()) sem WITH CHECK permite gravar qualquer valor novo na linha. O trigger autoriza reserved -> confirmed (linha 225) sem perguntar se quem está fazendo é a service_role. E a única constraint sobre dinheiro, split_fecha (linha 188), só exige price = commission + payout — qualquer trio consistente passa. A 'regra de ouro' declarada na linha 7 do arquivo não é imposta por nada.

**Como quebra.** A anon key está dentro do APK por definição. Com um login de cliente comum e curl: update service_requests set status='confirmed' where id=X — serviço garantido, zero PIX, e o walker recebe push 'Pagamento confirmado' (maquina-de-estados.md linha 112). Ou, antes de pagar: update service_requests set price_cents=100, commission_cents=20, payout_cents=80 where id=X — o PIX é gerado por R$ 1,00 e split_fecha aprova. Os dois casos só aparecem no fechamento do mês, quando o extrato do Mercado Pago não bate com o banco.

### 23. Qualquer usuário vira walker e lê o endereço residencial de todos os clientes; walker suspenso anula a própria suspensão

*Lente: Operação*

**Problema.** Três buracos que se somam. (1) update profiles set role='walker' passa: a policy só exige id = auth.uid(). (2) A policy da linha 431 mente no nome — não há filtro de proximidade nenhum: status='requested' and my_role()='walker' entrega address_text e address_geog de todo pedido aberto da cidade. (3) walker_profiles for all inclui UPDATE das colunas administrativas: suspended_at, verified_at, rating_avg, rating_count e mp_user_id são graváveis pelo próprio walker. RLS não faz controle por coluna; policy nenhuma resolve isso.

**Como quebra.** Sábado 23h você suspende um walker por maus-tratos: update walker_profiles set suspended_at = now(). Domingo de manhã ele roda update walker_profiles set suspended_at = null, verified_at = now(), rating_avg = 5.00, rating_count = 180 where user_id = auth.uid() e está atendendo de novo, verificado e bem avaliado. Em paralelo, um script com login de cliente comum faz update profiles set role='walker' e coleta o endereço completo de todos os pedidos abertos de Foz. A decisão 6 do ADR ('localização de pessoa não vaza') é falsa por dois caminhos independentes.

### 24. O trigger de estados não dispara em update de walker_id, e o early-return permite roubo silencioso do pedido

*Lente: Operação*

**Problema.** Dois defeitos na mesma função. (a) 'of status' faz o trigger só disparar quando a coluna status aparece na lista do SET. Um update service_requests set walker_id = <outro> não passa por validação alguma. (b) Mesmo quando dispara, o early-return da linha 221 devolve NEW inteiro — inclusive um walker_id novo — sem validar nada. O documento (maquina-de-estados.md, linha 126) coloca a proteção contra corrida na responsabilidade do app ('o update deve rodar com where status = requested'). Isso é exatamente o tipo de regra que se perde no terceiro refactor de quem programa 5h por semana.

**Como quebra.** Sábado 14h58, dois walkers tocam Aceitar no mesmo pedido com 300 ms de diferença. Se o app esquecer o where status='requested' — ou se o retry automático do cliente HTTP reenviar —, o segundo update faz reserved -> reserved, cai no early-return e grava o walker_id do segundo. Nenhum erro, nenhuma linha afetada igual a zero. Os dois receberam push de confirmação. Às 15h aparece o primeiro walker; o cliente estava esperando o segundo (foi o nome que ficou na tela dele). Nos dados não existe absolutamente nada indicando que houve dois aceites.

### 25. walkers_for_request() devolve zero linhas para qualquer cliente — o matching não funciona em produção

*Lente: Operação*

**Problema.** Função SECURITY INVOKER roda com as permissões do chamador, então o RLS de walker_locations é aplicado dentro dela. Um cliente não tem linha em walker_locations, logo o join devolve conjunto vazio — sempre, para todo pedido. A decisão 6 do ADR ('clientes não leem walker_locations direto, usam walkers_for_request()') descreve um comportamento que o código não tem. Também falta o grant/revoke de execute.

**Como quebra.** Épico 4 entra no ar. Em desenvolvimento tudo funciona, porque você testa com service_role no SQL editor ou logado como walker (aí a função retorna você mesmo). Em produção, com conta de cliente, a tela 'walkers perto de você' fica vazia para 100% dos usuários e não há erro nenhum no log. Você vai procurar o problema no PostGIS, no raio, no GPS do celular — o problema é uma palavra que falta na assinatura da função.

### 26. Webhook de pagamento para reserva já expirada faz rollback e apaga o registro do pagamento

*Lente: Operação*

**Problema.** A exceção do trigger aborta a transação inteira da Edge Function. Se o insert/update de payments estiver na mesma transação — que é o caminho natural e o que qualquer pessoa escreve primeiro —, o registro do pagamento é revertido junto com a transição. Resultado: o Mercado Pago tem R$ 40 do cliente e o seu banco não tem nenhuma linha ligando aquele dinheiro a um pedido. Não existe external_reference, não existe coluna de 'precisa estornar', não existe fila de estorno. O doc chama isso de resolvido; está apenas descrito.

**Como quebra.** 23h12 de sábado. O cliente paga no minuto 10:40 da reserva; a notificação do banco atrasa; o job já expirou a reserva às 10:00. O webhook chega, o trigger explode, a Edge Function retorna 500, o Mercado Pago reprocessa 5 vezes e desiste. Segunda-feira o cliente liga. Você faz select * from payments where request_id = ... e não vem nada. Faz select raw_webhook — nada. A única prova está no painel do MP, e nada naquele pagamento aponta para o pedido.

### 27. Não existe nenhuma tabela de eventos: o serviço que deu errado é literalmente indepurável

*Lente: Operação*

**Problema.** service_requests guarda o estado atual e seis timestamps (linhas 173-179). Não há registro de quem fez, de onde veio, com qual payload, nem do que foi tentado e falhou. Um cancelamento não diz quem cancelou nem sob qual das quatro categorias de cancellation_split. Um push não entregue não deixa rastro. Um webhook processado não deixa rastro após o próximo sobrescrever raw_webhook. O job de expiração devolve um integer que ninguém guarda.

**Como quebra.** 23h de sábado. Cliente no WhatsApp: 'paguei R$ 40 e o passeador nunca chegou'. Você abre o banco: status='confirmed', confirmed_at 21:40, started_at null, walker_id preenchido. E acabou. Não dá para saber se o walker abriu o app, se o push chegou, se ele tentou dar start e recebeu erro, se cancelou e o app engoliu a exceção, se estava a 200 m dali. Você não tem base para decidir entre estornar (e perder margem sobre um serviço talvez prestado) ou não estornar (e perder o cliente). Devolve o dinheiro por falta de dados — e o mesmo bug acontece na semana seguinte, porque você continua sem saber qual era.

### 28. Falta a camada RPC — sem ela o app é SQL, contra a decisão do dono, e cada regra vira uma policy impossível de escrever

*Lente: Operação*

**Problema.** supabase.from('service_requests').update({status:'reserved'}) é SQL com outra sintaxe: acopla o app ao nome de cada coluna e faz de toda a tabela superfície de escrita. Isso viola a decisão do dono ('o app não pode conter SQL, nem depender de conhecer o schema') e é a causa-raiz dos quatro primeiros achados desta lista. Policy não consegue expressar 'só pode mudar status junto com walker_id, se a linha ainda estiver aberta, nunca o preço, e gerando uma notificação' — isso é um procedimento, não um predicado.

**Como quebra.** Cada épico novo adiciona colunas e, com elas, novas formas de o app escrever coisas erradas. Com 5h por semana você não vai reauditar 8 policies por release. E o dia em que você renomear payout_cents, o app antigo na Play Store quebra para todo mundo que não atualizou — exatamente o problema que a decisão 2 do ADR quis evitar com o preço.

---

## Alto (33)

### 1. Nada impede o mesmo walker de aceitar 10 serviços no mesmo horário; passeio coletivo e o limite de 3 cães não existem no schema

*Lente: Negócio*

**Problema.** O modelo é 1 solicitação = 1 pet = 1 walker, sem nenhuma restrição temporal. Não existe `walk_group_id`, não existe checagem de sobreposição entre `scheduled_at` e `scheduled_at + duration_minutes` para o mesmo walker, nem para o mesmo pet. O limite de 3 cães por passeio coletivo dos Termos não é violável pelo schema porque o passeio coletivo não existe como entidade — mas acontece de fato: o walker aceita N pedidos no mesmo horário e sai com N cães. Sem grupo, também não há como o tutor saber que o passeio é coletivo, o que é informação material nos Termos.

**Como quebra.** Sábado, 15h. Um walker aceita 6 solicitações de 60 minutos marcadas para 15h, em bairros diferentes. O banco aceita todas: `reserva_tem_walker` (linha 189) só exige walker_id e reserved_until. Seis tutores pagam PIX, seis serviços vão para `confirmed`. Ele leva 6 cães juntos, ou simplesmente não aparece em 5 deles — e como `confirmed → cancelled_walker` devolve 100%, a plataforma estorna R$ 200 e perde R$ 40 de comissão num sábado.

### 2. A view clients_pay_first não é aplicada, conta expirações que não são culpa do cliente, e o fluxo "pagar antes" não existe

*Lente: Negócio*

**Problema.** Três problemas empilhados. (1) A view não é referenciada por nenhuma policy, trigger, função ou constraint — é um SELECT que ninguém roda. (2) O filtro é `status = 'expired'`, mas `expired` tem duas origens segundo maquina-de-estados.md linha 15: "requested → expired : ninguém aceitou (job)". Um pedido que nenhum walker aceitou expira e conta como abuso do cliente — a punição cai justamente em quem tentou pedir num horário ruim. (3) Mesmo que a view funcionasse, não existe o fluxo alternativo: a máquina de estados não tem estado de "pagou antes do aceite", `requested` não admite `confirmed` (linha 224), e não há coluna `pay_first` em `profiles`. A Decisão 3 descreve um segundo fluxo de negócio inteiro que não tem estado nenhum. Bônus: a view, sem `security_invoker`, roda com privilégio do dono e expõe a contagem de todos os clientes para quem tiver o grant.

**Como quebra.** Cidade de 5 walkers. Tutor pede passeio para as 6h da manhã três vezes numa semana; ninguém aceita; o job expira os três. Na quarta vez, se o anti-abuso estivesse ligado, ele seria tratado como caloteiro. E, do outro lado, o abusador real — que aceita reserva e nunca paga — não sofre nada, porque a view não está plugada em lugar algum.

### 3. Pedidos em 'requested' nunca expiram: o job só limpa 'reserved'

*Lente: Negócio*

**Problema.** A máquina de estados promete um job que expira pedidos que ninguém aceitou. Esse job não existe. `expire_stale_reservations()` só pega `status = 'reserved' and reserved_until < now()`. Um pedido em `requested` não tem prazo nenhum: não há `expires_at`, e `scheduled_at` passar não muda nada. A policy da linha 431-435 mostra ao walker **todo** pedido com `status = 'requested'`, sem filtro de data.

**Como quebra.** Três meses de operação. O feed do walker abre com 40 pedidos, 31 deles com `scheduled_at` no passado — passeios de agosto que ninguém aceitou. O walker precisa garimpar. Pior: ele aceita um pedido de 20 dias atrás, a transição `requested → reserved` é válida, `reserved_until` é carimbado para daqui a 10 minutos e o cliente recebe o push da linha 111 ("Fulano aceitou. Pague em 10 minutos") para um passeio que já passou. Se ele pagar, `cancellation_split` com `horas` negativo cai no ramo de 50%.

### 4. Custódia de chave (Termos §10) não tem registro nenhum — e é o serviço de gato inteiro

*Lente: Negócio*

**Problema.** Visita em casa a gato pressupõe que alguém entrega uma chave a um desconhecido e a recebe de volta. Os Termos §10 tratam disso, o schema não tem uma linha sequer: quem entregou, quando, quantas cópias, foto da entrega, quando devolveu, foto da devolução, e se a chave ficou em custódia entre visitas recorrentes. Não há como responder "o walker devolveu a chave?" nem provar a devolução numa disputa. E metade do catálogo do produto (gato → visita) roda em cima desse buraco.

**Como quebra.** Tutor viaja, deixa a chave com o walker para 5 visitas. Na terceira, o walker some. Tutor liga para o dono da plataforma: "quem está com a chave da minha casa?". A resposta que o banco dá é: existe um `service_request` do tipo visit com aquele walker_id. Nada mais. Não há data de entrega, não há foto, não há declaração assinada, e os Termos §10 provavelmente fazem promessas que o sistema não consegue nem registrar, muito menos cumprir.

### 5. Registro de incidente (Termos §11, prazo de 24h) não existe — e a máquina de estados delega a ele explicitamente

*Lente: Negócio*

**Problema.** O documento de estados resolve um caso de borda real (walker abandona o serviço em andamento) empurrando-o para um mecanismo que não foi construído. Não há tabela `incidents`, não há como registrar fuga, mordida, lesão, animal ferido, dano ao imóvel, chave perdida, walker que não apareceu. E o prazo de 24h dos Termos é inaplicável sem um `reported_at` comparado ao `completed_at` do serviço: sem esses dois carimbos no mesmo lugar, ninguém consegue dizer se o relato chegou dentro do prazo. Também não há nenhuma coluna que segure o repasse enquanto o incidente está aberto — e o split do Mercado Pago já mandou R$ 32 ao walker no instante da aprovação do PIX.

**Como quebra.** Passeio de terça, cão foge e volta machucado. Tutor manda WhatsApp na quinta (48h). O dono precisa saber se o prazo dos Termos §11 já venceu, quanto foi pago, se o walker tem histórico e se cabe suspensão. O banco tem um `service_request` com status `completed` e nada mais. Ele decide no improviso, e o próximo caso ele decide de outro jeito — o que é exatamente o risco jurídico que a v1 sem seguro (ADR linha 182-183) não pode correr.

### 6. mp_user_id é opcional no banco, e walkers_for_request() não o exige — o split da Decisão 5 quebra silenciosamente

*Lente: Negócio*

**Problema.** O ADR diz obrigatório. O schema diz `text unique` sem `not null` e sem nenhum filtro. `walkers_for_request()` filtra suspensão, raio, espécie e porte — não filtra conta do Mercado Pago. Nem `verified_at` (o ADR linha 185-186 diz que verificação é manual, mas nada impede um não verificado de aceitar). E nada, no aceite (`requested → reserved`), exige que o walker tenha conta para receber.

**Como quebra.** Walker se cadastra, pula a etapa de vincular o Mercado Pago, aparece no resultado de `walkers_for_request()` e aceita um pedido. A Edge Function precisa criar o PIX com `application_fee` e o `collector` do walker; sem `mp_user_id`, ou ela falha (cliente vê erro genérico com o walker já travado por 10 minutos) ou ela cai no caminho de gerar o PIX na conta da plataforma. No segundo caso os R$ 40 inteiros entram no caixa da plataforma e é preciso repassar R$ 32 à mão — o exato cenário que a Decisão 5 rejeitou por trazer "obrigação contábil, float no caixa e trabalho operacional diário". E contamina a decisão fiscal: R$ 40 transitando na conta da plataforma enfraquece a tese de que a receita é R$ 8.

### 7. Reembolso parcial de 50% não cabe em payments; não há tabela de estorno nem mp_refund_id

*Lente: Negócio*

**Problema.** `payment_status` é um único valor por linha de pagamento: ou 'approved' ou 'refunded'. A regra do ADR exige estorno de 50% (R$ 20 de R$ 40), que não é nem um nem outro. Não há `refunded_amount_cents`, não há `mp_refund_id`, não há data de estorno. O índice único `payments_um_aprovado_por_request` (linha 300-301) é parcial `where status = 'approved'` — marcar o pagamento como 'refunded' libera o slot e permite um segundo pagamento aprovado para o mesmo serviço. E o estorno no split puxa de volta tanto a application_fee quanto a parte do walker: se o walker já sacou os R$ 32, a conta MP dele fica negativa e ninguém no schema registra esse passivo.

**Como quebra.** Cliente cancela às 14h50 um passeio das 16h — menos de 2h, estorno de R$ 20. A Edge Function chama o refund parcial no Mercado Pago. O que ela grava? Se marcar `status = 'refunded'`, o serviço passa a constar como não pago e o índice único libera; se deixar 'approved', o estorno não existe no banco. Na conciliação do mês, o extrato do MP tem uma linha de refund de R$ 20 sem contrapartida, e a NFS-e de comissão precisa ser de R$ 4 — informação que não existe em lugar nenhum (ver achado 6).

### 8. Avaliação pode ser inserida contra qualquer walker, e refresh_walker_rating quebra em DELETE

*Lente: Negócio*

**Problema.** Dois defeitos. (a) A policy é `with check (client_id = auth.uid())` e o trigger `assert_review_completed` só verifica que o `request_id` está `completed` — nada compara `new.client_id` com `sr.client_id` nem `new.walker_id` com `sr.walker_id`. Qualquer usuário logado pode avaliar o serviço de outra pessoa e, pior, apontar `walker_id` para um walker qualquer. Com a suspensão automática por nota baixa (achado 8), isso vira arma: um walker afunda o concorrente. (b) `refresh_walker_rating` é `after insert or update or delete for each row` e usa `new.walker_id`; em DELETE, `NEW` não existe e o statement aborta com "record new is not assigned yet" — o suporte não consegue apagar uma avaliação caluniosa, nem a exclusão em cascata de um perfil funciona.

**Como quebra.** (a) Walker A cria uma conta de tutor, encontra qualquer `request_id` concluído (a policy "avaliações são públicas", linha 450-451, ajuda a mapear) e insere 5 reviews de nota 1 com `walker_id` = walker B. `rating_avg` de B despenca e, com o mecanismo de suspensão ligado, B sai do pool. (b) Dono tenta `delete from reviews where id = '...'` para corrigir: erro de plpgsql, e o registro difamatório fica.

### 9. O app precisa conhecer o schema para funcionar — contra a restrição "o app não pode conter SQL"

*Lente: Negócio*

**Problema.** Do jeito que está, a única forma de o app criar uma solicitação é um INSERT com 13 colunas em `service_requests`, incluindo `address_geog` em geography(Point,4326), `pricing_id`, os três campos de dinheiro e `terms_version`. Aceitar um serviço é um UPDATE com `where status='requested'` (a própria maquina-de-estados.md linha 126-128 instrui o app a escrever essa cláusula). Isso é SQL no app, mesmo escondido atrás do SDK do supabase-js: o app conhece nomes de tabela, nomes de coluna, tipos PostGIS e a regra de concorrência. Qualquer renomeação quebra os dois binários publicados na loja — o mesmo argumento da Decisão 2 sobre não depender de atualização por loja.

**Como quebra.** Seis meses depois, o dono precisa dividir `service_requests` ou renomear `payout_cents` para acomodar o campo de comissão final (achado 6). Os apps Android instalados continuam mandando o nome antigo. Ele não pode migrar o schema sem quebrar quem não atualizou, exatamente o cenário que a Decisão 2 tenta evitar para o preço — e agora para o schema inteiro.

### 10. A view clients_pay_first ignora RLS e entrega a base de clientes para a anon key

*Lente: Postgres*

**Problema.** Postgres 15 cria views com security_invoker = false por padrão: a view é executada com os privilégios do dono (postgres), que é dono de service_requests e portanto ignora a RLS habilitada na linha 387. No Supabase, os default privileges do schema public concedem SELECT em views novas para anon e authenticated. Há ainda um defeito de lógica: a view conta qualquer linha em 'expired', inclusive as que expiraram sem nenhum walker ter aceitado, e se apoia em cancelled_at, que o trigger da linha 243-244 carimba também para 'expired'.

**Como quebra.** Qualquer pessoa com a anon key (que vive dentro do APK, extraível com apktool) faz GET /rest/v1/clients_pay_first e recebe o client_id de todos os tutores com reservas expiradas mais a contagem. É um vazamento de base de usuários por uma view de manutenção. Segundo cenário: depois de implementar a expiração de 'requested' (achado 12), um cliente que pediu três vezes num horário sem walker disponível é punido com pagamento antecipado por culpa da oferta, não dele.

### 11. profiles não tem policy de INSERT e a de UPDATE permite virar admin

*Lente: Postgres*

**Problema.** Com RLS habilitada e nenhuma policy FOR INSERT, todo INSERT em profiles é rejeitado com 'new row violates row-level security policy'. O Épico 1 não sobe. E a policy de update, `using (id = auth.uid()) with check (id = auth.uid())`, verifica apenas a identidade da linha — nada impede o usuário de trocar a própria coluna `role`.

**Como quebra.** (a) Usuário se cadastra, auth.users grava a linha, o app tenta criar o perfil e recebe 42501. Sem perfil, my_role() devolve NULL e todas as policies que dependem dele reprovam — o cadastro trava no primeiro passo e nenhum épico seguinte funciona. (b) Depois de criado o perfil: PATCH /rest/v1/profiles?id=eq.<eu> com {"role":"admin"}. Passa. Como o enum tem 'admin' (linha 17), qualquer policy futura baseada em papel administrativo já nasce furada.

### 12. reviews não amarra client_id nem walker_id ao serviço avaliado

*Lente: Postgres*

**Problema.** assert_review_completed() verifica apenas que o request_id existe e está 'completed'. Não verifica que new.client_id é o client_id daquele request, nem que new.walker_id é o walker_id daquele request. A policy de insert só confere client_id = auth.uid(). Ou seja, as duas pontas da avaliação são dados livres vindos do app.

**Como quebra.** Walker A quer derrubar a nota do walker B. Ele conclui um serviço qualquer (é cliente de si mesmo num pedido antigo, ou usa um request_id concluído que conhece) e insere {"request_id": <um request completed qualquer>, "client_id": <ele mesmo>, "walker_id": <B>, "rating": 1}. Passa no trigger, passa na policy, passa no unique de request_id. A nota de B cai e não há como distinguir a avaliação falsa da verdadeira — inclusive porque reviews é de leitura pública (linha 450-451).

### 13. pricing_vigente_unico não impede janelas sobrepostas; falta btree_gist e current_pricing devolve NULL em silêncio

*Lente: Postgres*

**Problema.** O índice parcial cobre apenas o caso 'duas linhas em aberto ao mesmo tempo'. Ele não impede duas linhas cujas janelas [active_from, active_to) se cruzem, que é o caso real de troca de preço. E current_pricing, com `order by active_from desc limit 1`, escolhe silenciosamente uma das linhas sobrepostas em vez de falhar. Quando não existe linha vigente, a função SQL que `returns pricing` devolve NULL composto, sem exceção.

**Como quebra.** Em 01/10 o preço vai de R$ 40 para R$ 45. O operador insere a nova linha com active_from = '2026-10-01' e active_to = '2026-12-31' (fim de promoção) e esquece de fechar a antiga, que segue com active_to null. O índice parcial não barra, porque a nova tem active_to preenchido. De 01/10 a 31/12 existem duas linhas vigentes: current_pricing devolve a de R$ 45 por active_from ser maior; a partir de 01/01 a antiga volta a valer sozinha e o preço cai para R$ 40 sem ninguém ter mexido em nada. Segundo cenário: alguém fecha a linha de 'visit' sem abrir a substituta — current_pricing devolve NULL, o snapshot fica NULL e o insert morre com 'null value in column price_cents' em vez de uma mensagem que diga o que houve.

### 14. expire_stale_reservations() sem search_path, sem agendamento na migration, e nada expira 'requested'

*Lente: Postgres*

**Problema.** O ADR (decisão 3) e a máquina de estados chamam esse job de 'o ponto de falha silencioso mais provável de todo o sistema' e, mesmo assim, o agendamento está fora da migration. Além disso, a transição requested → expired existe no trigger (linha 224) e no diagrama, mas nenhuma função a executa: pedidos que ninguém aceitou nunca saem de 'requested'. A função também não fixa search_path — se um dia for promovida a SECURITY DEFINER sem isso, vira o mesmo vetor do achado 7.

**Como quebra.** Em janeiro o dono roda `npx supabase db reset` para testar o Épico 6 e não relê o README. O banco sobe com todas as tabelas e triggers, sem o job. Nada dá erro. Reservas ficam presas em 'reserved' para sempre, os walkers dessas reservas nunca voltam ao pool e o app parece vazio. Em paralelo, pedidos de agosto com scheduled_at vencido continuam na lista dos walkers para sempre.

### 15. Todo walker lê o endereço exato de todos os pedidos abertos da cidade — a policy diz 'perto dele' e não filtra nada

*Lente: Segurança*

**Problema.** O nome da policy promete filtro geográfico; a expressão não tem nenhum. Nenhum st_dwithin, nenhum join com walker_locations, nenhum limite de raio. Qualquer usuário com role = 'walker' faz SELECT * em todas as solicitações abertas e recebe address_text, address_geog, scheduled_at, client_id e pet_id. Além disso, `radius_m` (L55) existe na tabela mas não é usado em nenhuma policy — só dentro de walkers_for_request, que hoje não funciona. Somado ao achado do role editável, o requisito 'ser walker' custa um PATCH.

**Como quebra.** 1) Atacante vira walker (PATCH em profiles.role) ou é um walker real de má-fé. 2) GET /rest/v1/service_requests?status=eq.requested&select=address_text,address_geog,scheduled_at,client_id&limit=1000 — o PostgREST pagina sem esforço. 3) Roda a cada 60 s e persiste. Em um mês tem a lista de endereços residenciais de Foz com animal em casa, o horário exato em que cada tutor agendou o serviço (ou seja, quando estará ocupado ou fora), e a frequência da rotina. 4) Depois de aceitar qualquer pedido, a policy de pets (L413-419) ainda entrega `risk_notes` — 'cachorro medroso, não late' é informação sobre a defesa da casa. 5) Nada disso deixa rastro: leitura não gera log.

### 16. walker_profiles com SELECT público entrega chave PIX e conta do Mercado Pago para quem nem tem conta

*Lente: Segurança*

**Problema.** `using (true)` libera todas as linhas e, como RLS não filtra coluna, todas as colunas. A tabela guarda `pix_key` (na prática CPF, telefone ou e-mail do walker) e `mp_user_id` (o identificador da conta que recebe o split). No Supabase o schema public tem grant default de SELECT para `anon`, então isso vale sem login: basta a anon key, que está dentro do APK. A policy resolve um problema real (o cliente precisa ver o walker) com a ferramenta errada — exposição total em vez de projeção de colunas.

**Como quebra.** 1) Atacante baixa o APK, extrai SUPABASE_URL e a anon key (strings no bundle). 2) curl 'https://<proj>.supabase.co/rest/v1/walker_profiles?select=*' -H 'apikey: <anon>' — sem nenhum login. 3) Recebe a lista completa: user_id, pix_key, mp_user_id, verified_at, suspended_at, rating. 4) Cruza com GET /rest/v1/reviews?select=* (também `using (true)`, L450-451) para ter volume de serviços por walker. 5) Aplica o golpe clássico do PIX: liga para tutores dizendo ser da plataforma e manda pagar direto na chave do walker — chave real, o que dá credibilidade total —, ou cria um perfil falso do walker em rede social com a chave verdadeira. 6) `mp_user_id` vazado ainda permite mapear as contas Mercado Pago dos walkers. Do ponto de vista da LGPD é tratamento sem base legal: chave PIX não precisa ser pública para o cliente escolher um passeador.

### 17. Reviews sem vínculo com o serviço: derrubar a nota de qualquer walker custa um POST

*Lente: Segurança*

**Problema.** O WITH CHECK só confere que o autor está assinando com o próprio uuid. Não confere que `client_id` é o cliente daquele request, nem que `walker_id` é o walker daquele request. O trigger complementa muito pouco: verifica apenas que o request está 'completed', sem olhar quem participou dele. Como `walker_id` é um campo livre do payload e os uuids dos walkers são públicos (L404-405), o rating de qualquer walker é escrevível por qualquer usuário. E o trigger `refresh_walker_rating` recalcula a média na hora, sem nenhuma validação.

**Como quebra.** 1) GET /rest/v1/walker_profiles?select=user_id — lista de todos os walkers. 2) O atacante precisa de um request_id em 'completed'; ele consegue um dos próprios serviços, ou simplesmente insere uma solicitação já 'completed' (ver o achado do status livre no INSERT) — custo zero. 3) POST /rest/v1/reviews com `{"request_id":"<esse>","client_id":"<eu>","walker_id":"<uuid do walker alvo>","rating":1,"comment":"maltratou meu cachorro"}`. 4) O trigger encontra status = 'completed' e deixa passar; refresh_walker_rating derruba o rating_avg do alvo. 5) Repetindo com solicitações forjadas diferentes (o unique é em request_id, não em walker_id), um concorrente zera a nota dos 5 walkers da cidade numa tarde. 6) A leitura pública de `reviews` ainda expõe `client_id` — dá para ligar um comentário público ao uuid de um tutor e, cruzando com as reviews dele, montar o histórico de quem contratou quem.

### 18. A view clients_pay_first roda como o dono e é legível por qualquer um

*Lente: Segurança*

**Problema.** Em Postgres, uma view criada sem `security_invoker = on` executa com os privilégios do dono — no Supabase, um papel que ignora RLS. Combinado com o grant default do schema public, qualquer usuário autenticado (e, dependendo dos grants, `anon`) lê a view e recebe o `client_id` e a contagem de expirações de **todos** os clientes, furando a policy L422-423 que restringe service_requests ao próprio dono. É o furo mais comum de projetos Supabase (o linter chama de `security_definer_view`) e aqui carrega justamente a informação disciplinar da decisão 3 do ADR.

**Como quebra.** 1) GET /rest/v1/clients_pay_first?select=* com qualquer JWT. 2) Retorna a lista de uuids de clientes com 3 ou mais reservas expiradas em 30 dias. 3) Um walker sabe de antemão quem são os maus pagadores da cidade e recusa; um concorrente sabe quem abandona pedido e liga para essas pessoas. 4) O dado é derivado de solicitações que o chamador não tem direito de ver — a RLS de service_requests é contornada pela view, não por bug do Postgres, mas pelo default. 5) Pior: o mesmo padrão vai se repetir em toda view de relatório que for criada nos Épicos 7 e 8 se o default não for corrigido agora.

### 19. cancellation_split recebe a solicitação inteira como parâmetro do chamador — e o refund é escrevível pelo app

*Lente: Segurança*

**Problema.** A função recebe `p_request service_requests` — o registro vem de fora, não do banco. Exposta pelo PostgREST em /rest/v1/rpc/cancellation_split (funções em public são publicadas automaticamente, e o EXECUTE é de PUBLIC por padrão), o atacante decide os valores de entrada. Pior ainda: mesmo que a Edge Function chame corretamente, `refund_cents` e `final_payout_cents` são colunas comuns de service_requests, cobertas pelas policies de UPDATE do cliente e do walker — quem cancela grava o próprio desfecho financeiro. A função também recebe `p_by text` livre; qualquer string desconhecida (inclusive um erro de digitação) cai no `else` e aplica 50/50, que é o pior default possível para uma regra que está nos Termos de Uso seção 7.

**Como quebra.** 1) Cliente confirma um serviço para as 15h e às 14h50 decide cancelar — pela tabela do ADR (decisão 4) ele teria 50% de volta, R$ 20. 2) PATCH /rest/v1/service_requests?id=eq.<X> com `{"status":"cancelled_client","refund_cents":4000,"final_payout_cents":0}`. O trigger aceita a transição confirmed → cancelled_client, carimba cancelled_at e não olha valor nenhum — `cancellation_split()` não é chamada por trigger algum, não existe nenhuma amarração entre a função e a tabela. 3) A rotina de estorno do Épico 7 lê refund_cents e devolve R$ 40. O walker, que reservou o horário e talvez já esteja a caminho, recebe R$ 0 em vez dos R$ 16 que os Termos prometem. 4) Variante direta na função: POST /rest/v1/rpc/cancellation_split com `{"p_request":{"price_cents":999999,"payout_cents":0,"scheduled_at":"2027-01-01"},"p_by":"walker"}` devolve o refund que o atacante pediu — se qualquer código confiar nesse retorno, o valor veio do celular do usuário.

### 20. O walker não consegue aceitar pedido nenhum — e o remendo óbvio deixa ele roubar a reserva alheia

*Lente: Segurança*

**Problema.** No UPDATE, a expressão USING é avaliada sobre a linha **antiga**. Uma solicitação em 'requested' tem `walker_id` nulo, e `null = auth.uid()` é NULL, não verdadeiro — a linha é invisível para a policy. Nenhuma outra policy de UPDATE alcança o walker. Consequência: a transição requested → reserved, que o ADR (decisão 3) e maquina-de-estados.md L59 descrevem como 'app, RLS: walker_id = auth.uid()', é **impossível hoje**. Todo update do walker afeta 0 linhas e o app mostra 'outro walker já assumiu' para todo mundo. Isso é grave por si só — bloqueia os Épicos 3, 5 e 6 — e é mais grave pelo conserto que vai ser feito às pressas: acrescentar `or (status = 'requested' and my_role() = 'walker')` no USING. Aí a policy passa a permitir que um walker sobrescreva `walker_id` de qualquer linha, inclusive de uma já reservada por outro, porque o WITH CHECK implícito (herdado do USING) volta a ser satisfeito pela segunda cláusula.

**Como quebra.** Hoje: o walker toca 'Aceitar', o PATCH devolve `[]`, o app diz que outro assumiu, o pedido nunca sai de 'requested' e expira. Com uma pessoa programando 5h por semana e sem operação manual antes do lançamento, esse bug só aparece no primeiro teste de ponta a ponta com duas contas reais.

Depois do remendo ingênuo: 1) Walker A aceita o pedido, que vai para 'reserved' com reserved_until. 2) Walker B, que viu o pedido na lista aberta, manda PATCH /rest/v1/service_requests?id=eq.<X> com `{"walker_id":"<B>"}` — sem mexer no status, o que também evita o trigger `before update of status`. 3) O USING passa pela primeira cláusula? Não, a linha está 'reserved'. Mas se o remendo for `or my_role() = 'walker'` (variação igualmente provável), B assume a reserva de A, herda o cliente e o endereço, e recebe o repasse do serviço que A conseguiu. 4) Como não há audit log, a disputa entre os dois walkers é irresolúvel.

### 21. Webhook fora de ordem rebaixa um pagamento aprovado de volta para pending

*Lente: Operação*

**Problema.** O Mercado Pago não garante ordem de entrega de payment.updated e faz retry de eventos antigos. O handler natural (update payments set status = <do payload> where mp_payment_id = ...) aceita approved -> pending. O índice único payments_um_aprovado_por_request (linha 300) protege contra dois aprovados, não contra um aprovado que regride. Não existe nada equivalente ao assert_status_transition de service_requests do lado do pagamento.

**Como quebra.** 23h07: o cliente paga, o evento approved chega, service_requests vai para confirmed, os dois recebem push. 23h08: chega o retry de um evento 'pending' emitido 4 segundos antes do approved. O update passa. Agora você tem service_requests.status = 'confirmed' e payments.status = 'pending' para o mesmo pedido, e raw_webhook guarda só o payload pending. Qualquer relatório de conciliação que você escrever vai listar esse serviço como não pago, e você não tem como provar o contrário sem abrir o painel do MP.

### 22. Dois PIX pendentes para o mesmo pedido, e estorno parcial não cabe no modelo de dados

*Lente: Operação*

**Problema.** Nada impede dois registros 'pending' para o mesmo request_id — dois QR codes de R$ 40 válidos ao mesmo tempo, cada um com sua idempotency_key. E o cancelamento com 50% previsto na decisão 4 do ADR precisa devolver R$ 20 de um pagamento de R$ 40: 'refunded' é tudo-ou-nada, não existe onde escrever 'estornei 2000 dos 4000', nem refunded_at, nem mp_refund_id.

**Como quebra.** Cliente aperta Gerar PIX, a tela trava por rede ruim, ele volta e gera de novo. Paga o QR antigo; depois, por engano, paga o novo também. O primeiro webhook confirma. O segundo bate no índice único payments_um_aprovado_por_request, a Edge Function estoura 500, o MP faz retry em loop — e você tem R$ 80 recebidos para um serviço de R$ 40, com o segundo pagamento sem registro nenhum no banco por causa do rollback. Nada em lugar algum diz que existe um estorno a fazer.

### 23. Não existe a base de cálculo da nota fiscal quando há cancelamento — a comissão efetiva não é gravada em lugar nenhum

*Lente: Operação*

**Problema.** A decisão do dono de 11/09/2026 é que a NF é sobre a comissão. No caminho feliz a comissão é commission_cents. No cancelamento tardio, cancellation_split devolve R$ 20 ao cliente e R$ 16 ao walker: sobram R$ 4 de comissão efetiva, e não existe coluna para guardar isso. split_fecha só valida o trio original e não é reavaliada no desfecho; nada garante refund + final_payout <= price. Pior: cancellation_split usa now() na linha 262 para medir as 2 horas, então reexecutá-la amanhã sobre um cancelamento de hoje devolve outro número — o cálculo não é auditável nem reproduzível. E a função é stable e retorna um par que o app pode simplesmente ignorar ao gravar refund_cents.

**Como quebra.** Fim do mês, hora de emitir a NF da comissão. select sum(commission_cents) from service_requests where status='completed' ignora os cancelamentos, que também geraram receita. Somar os cancelados é impossível: você não tem final_commission_cents, não sabe qual das quatro categorias (client, walker, no_show_client, force_majeure) foi aplicada — nenhuma delas é armazenada — e não consegue recalcular, porque a função depende de now(). Qualquer número que você mandar ao contador é chute, sobre o único valor que a empresa fatura.

### 24. Nada impede um walker aceitar cinco pedidos para o mesmo horário — não existe noção de walker ocupado

*Lente: Operação*

**Problema.** O ADR (decisão 3, linha 67) afirma que ao expirar 'o walker volta a ficar disponível', mas nada no schema marca o walker como indisponível quando ele aceita. available é ligado e desligado à mão pelo próprio walker. Não há constraint entre walker_id, scheduled_at e duration_minutes. O mesmo vale para o pet: o mesmo cão pode ter dois passeios simultâneos com walkers diferentes.

**Como quebra.** Sábado de manhã um walker aceita 5 pedidos para as 15h, para garantir a renda do dia. Três clientes pagam dentro dos 10 minutos e viram confirmed. Às 15h ele atende um. Os outros dois viram cancelled_walker com reembolso de 100% (decisão 4): você devolve R$ 80, perde dois clientes e paga taxa de estorno. Nada no banco te avisou na hora do aceite, e você só descobre pelo WhatsApp no domingo.

### 25. expire_stale_reservations faz seq scan a cada minuto, sem limite e sem skip locked — e disputa lock com o webhook

*Lente: Operação*

**Problema.** O predicado é status='reserved' and reserved_until < now(). O índice (status, scheduled_at) não cobre reserved_until, então é seq scan a cada minuto, para sempre. O update roda sem limit e sem for update skip locked, então concorre por lock de linha com o webhook que está confirmando aquele mesmo pedido. E o integer retornado não é guardado por ninguém.

**Como quebra.** Dois modos de falha. (1) O job fica 6h parado (deploy, restore, pausa do projeto no plano free). Ao voltar, expira 300 linhas de uma vez, dispara 300 triggers e 600 pushes às 4h da manhã. (2) O job pega o lock da linha X no exato instante em que a Edge Function do webhook tenta confirmá-la. O webhook fica esperando, estoura o timeout da função, o MP faz retry — e você cai no cenário do achado do rollback, com o cliente pagando e o banco não registrando.

### 26. O cron é ponto único de falha silencioso, e há três alternativas que não dependem dele

*Lente: Operação*

**Problema.** Hoje 'reserved' é uma verdade física que só o cron converte em 'expired'. pg_cron falha em silêncio: não manda e-mail, não abre incidente, e no Supabase o agendamento some quando o projeto é pausado, restaurado de backup ou migrado de região. O próprio ADR reconhece que é 'o ponto de falha silencioso mais provável de todo o sistema' — mas a mitigação proposta (um alerta hipotético) nunca é construída, e não existe nenhum dado que permita responder 'o job rodou?'.

**Como quebra.** 23h de sábado, o app 'parece vazio': pedidos não aparecem para ninguém, walkers reclamam que não há trabalho, clientes reclamam que ninguém aceita. Nenhum erro em lugar nenhum, nenhum log, nenhuma métrica. Você não consegue nem responder em 2 minutos se o job está vivo, porque expire_stale_reservations() devolve um número que ninguém guarda e não existe tabela de execuções.

### 27. O índice GiST nunca será usado por walkers_for_request, e 'available' não tem prazo de validade

*Lente: Operação*

**Problema.** ST_DWithin(geography, geography, float8) é uma função SQL que o planner faz inline para 'wl.geog && _ST_Expand(sr.address_geog, wp.radius_m) and _ST_DWithin(...)'. O operador && é indexável, mas aqui o lado direito depende de wp.radius_m, e wp só é alcançado por join com a PK de walker_locations. O planner sempre prefere a PK; o GiST não entra no plano — confirme com explain (analyze, buffers). Com 40 walkers em Foz isso não custa nada; o problema é acreditar que está indexado. O defeito real é outro: available não tem TTL nem índice. Quem ligou 'disponível' na terça e desligou o celular continua no resultado, com a coordenada de terça. E st_distance sobre geography roda no esferoide (COST 500 por linha) quando a esfera basta para distância urbana.

**Como quebra.** O cliente cria o pedido e a tela diz '12 walkers na sua região'. Nove estão offline há dias. Ninguém aceita. O cliente conclui que o app não tem gente e desinstala. Você olha o banco, vê 12 linhas com available = true e não entende. updated_at existe (linha 358) e nunca é consultado.

### 28. Walker sem mp_user_id aceita pedido, e o split do Mercado Pago só quebra depois que o cliente pagou

*Lente: Operação*

**Problema.** A decisão 5 do ADR (linha 115) declara mp_user_id 'obrigatório para o walker receber solicitações'. Essa obrigatoriedade existe só no documento: o schema não a impõe no cadastro, no matching, nem no aceite. verified_at tem o mesmo problema — walker com documento não conferido aparece normalmente no pool.

**Como quebra.** Walker se cadastra sábado à tarde, não conclui a vinculação com o Mercado Pago, aceita um pedido. O cliente paga. A criação do pagamento com application_fee falha por falta de collector — ou, pior, alguém implementa o fallback óbvio e o pagamento é criado sem split: os R$ 40 caem inteiros na sua conta. Isso é movimentar dinheiro de terceiro, exatamente o que a decisão 5 recusou, e faz o extrato (R$ 40) divergir da base da NF (R$ 8) para aquele serviço. Descobre-se no fechamento contábil, semanas depois.

### 29. refresh_walker_rating levanta exceção em qualquer DELETE de review, inclusive nos cascades

*Lente: Operação*

**Problema.** Em plpgsql, num trigger de DELETE, o registro NEW não é atribuído. Referenciar new.walker_id levanta 'record new is not assigned yet' (erro 55000). Portanto todo DELETE em reviews falha — inclusive os provocados pelos on delete cascade das linhas 309 e 311, que vêm de service_requests e de profiles.

**Como quebra.** 23h de sábado, um walker liga porque um cliente deixou um comentário difamatório. Você faz delete from reviews where id = ... e recebe um erro do Postgres que não menciona reviews nem rating. Tenta o caminho alternativo de apagar o perfil do cliente abusivo: o mesmo erro, agora vindo de um cascade, ainda mais difícil de ler. Perde a noite em algo que é uma linha de código.

### 30. O walker avalia a si mesmo cinco estrelas e, de quebra, impede o cliente de avaliar

*Lente: Operação*

**Problema.** Nada amarra new.client_id e new.walker_id às partes reais do pedido. Quem conhece o request_id — e o walker conhece todos os dele — insere client_id = auth.uid(), walker_id = auth.uid(), rating = 5. A policy aprova (client_id é mesmo o auth.uid() dele) e o trigger aprova (o serviço está concluído). Como request_id é unique (linha 309), a review falsa também bloqueia a verdadeira.

**Como quebra.** Um walker com média 2,4 descobre isso numa noite e planta rating 5 em todos os serviços concluídos dele que ainda não têm avaliação. A média sobe para 4,8, o trigger de rating atualiza walker_profiles sozinho, e os clientes passam a ver o botão Avaliar falhar com erro de chave duplicada. Você vai investigar 'bug no botão avaliar' e não vai olhar para a média.

### 31. Sem soft delete e sem anonimização: pedido de exclusão de dados trava em erro de chave estrangeira

*Lente: Operação*

**Problema.** Apagar o usuário no painel do Supabase cascateia para profiles, que é bloqueado pelo on delete restrict de service_requests — a exclusão falha com erro de FK e não há caminho alternativo. Se algum perfil sem histórico for apagado com sucesso, as reviews vão junto por cascade e disparam o bug do refresh_walker_rating em DELETE. Não existe deleted_at em nenhuma tabela, nem função de anonimização, nem separação entre 'dado pessoal' (apagável) e 'registro financeiro' (que você é obrigado a guardar).

**Como quebra.** Um walker que prestou 30 serviços pede exclusão de dados pela LGPD, por escrito. Você precisa apagar nome, CPF, telefone e chave PIX e ao mesmo tempo manter os valores dos serviços para o fisco. Hoje é tudo ou nada, e 'tudo' nem roda. Você responde 'não é possível', o que é uma resposta ruim de dar.

### 32. Nenhuma trilha de auditoria em preço, verificação e suspensão — e a versionagem de pricing é ficção

*Lente: Operação*

**Problema.** pricing é versionada em relação ao tempo, mas nada impede update pricing set price_cents = 4500 where id = <linha já referenciada por 300 snapshots>. O histórico se reescreve e os snapshots de service_requests passam a apontar para um pricing_id que já não descreve o que valia. Do lado das pessoas: não existe suspension_reason, suspended_by, verified_by. Ninguém sabe quem fez o quê.

**Como quebra.** Um walker suspenso num domingo reclama e ameaça processar. Você não sabe se foi você, se foi o sócio pelo painel, ou se foi um script de teste que ficou apontando para produção. Não há data separada de motivo, não há autor. Do outro lado, o cliente contesta o valor cobrado e você abre pricing: o preço lá é R$ 45 e o snapshot no pedido é R$ 40. Sem auditoria você não consegue afirmar qual estava certo na data.

### 33. Nenhum snapshot do pet: o tutor apaga risk_notes depois do incidente

*Lente: Operação*

**Problema.** O ADR é rigoroso com snapshot de preço (decisão 2) e de Termos (decisão 8) pela razão certa — 'é preciso provar o que valia naquele serviço' — e esquece o pet. risk_notes ('já mordeu', 'tem medo de moto', 'toma medicação às 16h') e rabies_vaccine_ok são reescritos pelo tutor a qualquer momento, inclusive depois do serviço.

**Como quebra.** O cão morde alguém durante o passeio. O walker diz que o tutor não avisou; o tutor diz que avisou. O tutor abre o app e apaga 'já mordeu duas vezes' de risk_notes — é um update legítimo pela policy. Você não tem cópia nem auditoria. Os Termos, seção 8, exigem que o tutor declare o risco, e você não consegue provar o que ele declarou. É o cenário em que a ausência de dado vira exposição jurídica, e a v1 não tem seguro (ADR, 'o que este documento não decide', item 2).

---

## Médio (22)

### 1. terms_version é texto livre: a Decisão 8 não prova nada

*Lente: Negócio*

**Problema.** A Decisão 8 existe para responder "qual texto valia naquele serviço". A coluna guarda a string que o app mandar — sem FK, sem tabela de versões, sem hash do conteúdo, sem URL arquivada. Os Termos hoje moram num link de artifact (ADR linha 194), que é editável e não versionado. Guardar 'v1.0' prova apenas que alguém digitou 'v1.0'. E nada impede o app de mandar uma versão que nunca existiu, ou de aceitar termos por outra pessoa.

**Como quebra.** Incidente com um cão em janeiro. Em março os Termos mudaram a cláusula de responsabilidade. A defesa depende de mostrar o texto de janeiro. O banco diz `terms_version = 'v1.0'`; o link do artifact mostra o texto de março; ninguém tem o de janeiro. A Decisão 8 foi cumprida na letra e falhou no objetivo.

### 2. Vacina antirrábica (Termos §8) é um booleano decorativo, sem validade e sem bloqueio

*Lente: Negócio*

**Problema.** O comentário no schema diz que o campo é exigido pelos Termos, mas nada o consome: não há trigger impedindo solicitação com `rabies_vaccine_ok = false`, o default é `false`, o dono do pet marca o próprio checkbox (policy da linha 410-411, `for all`), não há data de validade (vacina antirrábica vence em 12 meses) e não há comprovante anexado. `risk_notes` tem o mesmo problema: o walker só lê `pets` depois de aceitar (policy 413-419), ou seja, aceita um cão sem saber que ele é agressivo.

**Como quebra.** Tutor cadastra o cão com o default `false`, pede o passeio, walker aceita, cão sem vacina morde outro cão na rua. A plataforma tem, no banco, o registro explícito de que a vacina não estava ok e de que deixou o serviço acontecer mesmo assim — pior do que não ter o campo. E o walker aceitou sem ver `risk_notes`: o campo que diria "morde" só fica visível depois do aceite.

### 3. expire_stale_reservations() expira reserva com PIX pago em voo

*Lente: Negócio*

**Problema.** O job faz `update ... where status='reserved' and reserved_until < now()` sem olhar `payments`. O webhook do Mercado Pago não é instantâneo: o cliente paga aos 9min50s, o job roda aos 10min00s, o webhook chega aos 10min08s e encontra o pedido em `expired`. A documentação chama isso de caso de borda "raro", mas com TTL de 10 minutos e PIX pago no último minuto, não é raro — é o comportamento esperado de quem deixa para o fim. E o tratamento previsto (estornar) não tem tabela (achado 16) nem cabe no split, porque o estorno de R$ 40 precisa puxar de volta os R$ 8 já contabilizados como receita.

**Como quebra.** Sexta à noite, cliente paga às 21h09m50s. Job roda 21h10m00s → expired. Webhook 21h10m08s tenta `expired → confirmed`, o trigger levanta exceção (linha 231-233). A Edge Function precisa estornar. O walker recebe o push "reserva expirou" (maquina-de-estados linha 113) e pega outro serviço. O cliente pagou, viu o dinheiro sair, recebeu "expirou" e vai receber o estorno em D+1. Para um público de tutor comum em Foz, esse é o evento que mata a confiança no app.

### 4. payments não é conciliado com o snapshot do pedido: amount_cents e fee_cents aceitam qualquer valor

*Lente: Negócio*

**Problema.** Não há FK composta nem trigger ligando `payments.amount_cents` a `service_requests.price_cents`, nem `payments.fee_cents` a `commission_cents`. O comentário da linha 286 diz que `fee_cents` é "application_fee (nossa comissão)", mas o default é 0. Se a Edge Function errar o cálculo ou o Mercado Pago devolver um valor diferente do esperado, o banco aceita e a divergência só aparece na conciliação — que, com NF sobre a comissão, é a base do que vai para a nota.

**Como quebra.** Bug na Edge Function faz `fee_cents` ficar no default 0 durante duas semanas. Os PIX são criados sem application_fee: os R$ 40 inteiros vão para a conta do walker e a plataforma não recebe nada, em 30 serviços. Nenhum erro no banco, nenhum alerta. Só aparece quando o dono olha o extrato do MP no fim do mês — R$ 240 de comissão que não existem.

### 5. Exclusão de conta é impossível (cascade x restrict) e não há caminho de anonimização — LGPD

*Lente: Negócio*

**Problema.** Apagar o usuário no auth cascateia para `profiles`, que cascateia para `pets`, que bate em `service_requests.pet_id on delete restrict` — o DELETE aborta. Ou seja: nenhum usuário que já pediu um serviço pode ser excluído, e a operação falha com um erro de FK, não com uma mensagem. A Política de Privacidade v1.0 (mesmo documento dos Termos) certamente promete exclusão. Do outro lado, apagar de verdade destruiria o histórico fiscal e probatório que os achados 7 e 19 exigem guardar. Não há coluna `deleted_at`, nem rotina de anonimização, nem prazo de retenção declarado.

**Como quebra.** Tutor pede exclusão da conta por e-mail. O dono tenta apagar pelo painel do Supabase: erro de foreign key. Ele não tem alternativa no schema — ou deixa a conta ativa (descumprindo o pedido) ou apaga os service_requests, destruindo a base das notas fiscais de comissão já emitidas e das provas de aceite dos Termos.

### 6. Nenhuma policy dá acesso ao papel 'admin'; o suporte só existe via service_role

*Lente: Negócio*

**Problema.** O enum prevê admin e nenhuma das 15 policies o reconhece. Um usuário com role 'admin' vê exatamente o que um cliente vê: os próprios pedidos, que são zero. Todo atendimento — conferir documento para preencher `verified_at`, aplicar suspensão, marcar no-show do cliente (que a Decisão 4 exige: 15 minutos de espera, R$ 32 ao walker), resolver incidente — precisa de service_role, ou seja, do dono abrindo o painel do Supabase e escrevendo SQL à mão. Com 5h/semana, isso é o gargalo operacional do negócio inteiro, e cai na mesma restrição do dono de não ter SQL no fluxo de trabalho.

**Como quebra.** Domingo, walker reclama que o cliente não apareceu e ele esperou 15 minutos. Ninguém pode registrar `no_show_client`: não é o cliente (ele não vai se autodeclarar ausente), não é o walker (`cancelled_client` disparado por ele deveria ser proibido), e o admin não tem permissão. O dono abre o SQL editor do Supabase no celular e digita um UPDATE. É a operação manual que o ADR diz não existir.

### 7. cancellation_split(): p_by é text solto, divide inteiro sem regra e ignora o status do pedido

*Lente: Postgres*

**Problema.** Três defeitos. (1) p_by é `text` sem enum nem validação: qualquer valor que não seja uma das quatro strings exatas cai no `else` da linha 270, que é o ramo de 50%. (2) `(p_request.price_cents / 2)::integer` é divisão inteira (o cast é inócuo, ambos os operandos já são integer): o centavo ímpar é truncado sem que ninguém registre para onde foi. (3) A função não olha p_request.status: calcula reembolso de um dinheiro que pode nunca ter entrado.

**Como quebra.** A Edge Function de cancelamento manda 'no_show' em vez de 'no_show_client' (ou 'Client' com maiúscula). Não há erro: cai no else e devolve refund = 2000, payout = 1600. O cliente que faltou recebe R$ 20,00 de volta e o walker que esperou 15 minutos na porta recebe R$ 16,00 em vez de R$ 32,00 — exatamente o contrário da linha 3 da tabela da decisão 4 do ADR. Como o PIX de reembolso já saiu, o erro é irreversível e só aparece quando o walker reclamar.

### 8. service_requests é a única tabela central sem trigger de updated_at

*Lente: Postgres*

**Problema.** updated_at só é atualizado quando o status muda, e a coluna updated_at de service_requests existe com default (linha 186) mas nenhum trigger a mantém. Qualquer alteração que não mexa em status deixa updated_at congelado em created_at. walker_locations tem o mesmo problema — e lá é pior, porque updated_at é o único sinal de frescor da posição usado no filtro que sugiro no achado 5.

**Como quebra.** Cliente reagenda de 15h para 17h (PATCH em scheduled_at). O trigger de transição nem dispara, porque é `before update of status`. updated_at segue igual a created_at. Quando o app fizer sincronização incremental ('me dá tudo que mudou desde meu último fetch'), o reagendamento não aparece e o walker vai ao endereço no horário velho. No caso de walker_locations, o app atualiza geog sem tocar em updated_at, e o filtro de frescor descarta walkers que estão online agora.

### 9. walker_id pode apontar para um perfil de cliente e para um walker sem mp_user_id

*Lente: Postgres*

**Problema.** Nada garante que walker_id seja um perfil com role = 'walker', nem que esse walker tenha walker_profiles, nem que tenha mp_user_id preenchido. A policy de update do cliente (linha 428-429) permite que ele escreva walker_id com qualquer uuid de profiles.

**Como quebra.** Cliente A e cliente B combinam de fraudar: A cria o pedido e faz PATCH {"walker_id": <uuid de B, que é role client>, "status":"reserved"}. Passa por tudo. Cenário mais provável e mais caro: um walker legítimo que ainda não conectou a conta do Mercado Pago aceita o serviço; o cliente paga o PIX de R$ 40; na hora de aplicar o application_fee o split não tem conta destino e a Edge Function falha DEPOIS de o dinheiro ter entrado. Suporte manual, reembolso de PIX, exatamente o atrito que a decisão 3 do ADR quis evitar.

### 10. payments não amarra amount_cents nem fee_cents ao snapshot da solicitação

*Lente: Postgres*

**Problema.** fee_cents tem default 0 e nenhum CHECK de faixa. Não existe nenhuma verificação de que amount_cents = service_requests.price_cents nem de que fee_cents = service_requests.commission_cents. O índice único parcial de 'um aprovado por request' está correto e resolve o webhook duplicado, mas ele garante unicidade, não valor.

**Como quebra.** A Edge Function do Épico 5 monta o application_fee e passa 8 (reais) em vez de 800 (centavos) — erro clássico na integração do Mercado Pago, onde alguns campos são decimais e outros inteiros. O pagamento é aprovado, payments grava fee_cents = 8, o índice único não reclama, o pedido vai para confirmed e o serviço acontece. A plataforma recebeu R$ 0,08 em vez de R$ 8,00 e isso só aparece no fechamento do mês — que, pela decisão do dono de 11/09/2026, é justamente a base da nota fiscal da comissão.

### 11. CPF não é normalizado: o UNIQUE não impede o mesmo CPF cadastrado duas vezes

*Lente: Postgres*

**Problema.** O trigger valida o CPF depois de aplicar regexp_replace, mas grava o valor original. O UNIQUE é sobre o texto cru. Formatações diferentes do mesmo CPF são strings diferentes e passam pelo índice. Não há também rejeição de sequências repetidas.

**Como quebra.** Walker é suspenso (walker_profiles.suspended_at preenchido) por um incidente com um animal. Ele cria uma conta nova com o mesmo CPF digitado como '083.123.456-78' em vez de '08312345678'. O trigger aprova (11 dígitos após o regexp) e o UNIQUE aprova (texto diferente). A única barreira do sistema contra o walker banido voltar simplesmente não existe. Variante boba do mesmo bug: o usuário digita com espaço no fim e vira um cadastro duplicado.

### 12. A policy do walker entrega o endereço de todos os pedidos abertos da cidade, inclusive a walkers suspensos

*Lente: Postgres*

**Problema.** O nome da policy diz 'o que está aberto perto dele', mas a expressão não tem nenhum critério de proximidade, nem consulta walker_profiles.suspended_at. Qualquer perfil com role = 'walker' lê toda linha em 'requested', com address_text e address_geog. Isso contradiz a decisão 6 do ADR, que restringe o acesso do walker aos dados do animal até depois do aceite, mas libera o endereço da casa do tutor antes.

**Como quebra.** Walker suspenso por incidente — ou um cadastro qualquer que marcou role = 'walker' na tela de cadastro, já que não há verificação para virar walker — faz GET /rest/v1/service_requests?status=eq.requested&select=address_text,address_geog,scheduled_at. Recebe a lista de endereços residenciais com horário em que o tutor vai estar saindo de casa, na cidade inteira. Não é abuso de bug: é a policy funcionando como escrita.

### 13. payments.raw_webhook entrega os dados do pagador para o walker

*Lente: Segurança*

**Problema.** A policy está certa quanto à linha (as duas partes do serviço) e certa em não ter escrita — mas RLS não filtra coluna, e o PostgREST atende `select=*`. `raw_webhook jsonb` guarda o payload cru do Mercado Pago, que traz os dados do pagador: nome completo, e-mail, CPF em `payer.identification.number`, às vezes os últimos dígitos do instrumento. Ou seja, o walker lê o CPF e o e-mail do tutor a partir de um serviço qualquer, sem que o tutor tenha fornecido nada disso ao walker. É compartilhamento de PII sem base legal e sem necessidade — o walker só precisa saber se o pagamento foi aprovado.

**Como quebra.** 1) Walker aceita o serviço, o cliente paga, o webhook grava raw_webhook. 2) GET /rest/v1/payments?request_id=eq.<X>&select=* com o JWT do walker. 3) A policy autoriza a linha (sr.walker_id = auth.uid()) e vem o JSON completo do Mercado Pago. 4) O walker acumula CPF + nome + e-mail + endereço (que ele já tem pelo service_request) de cada tutor que atende. Base de dados pessoal completa montada por quem só deveria saber o primeiro nome e o telefone. 5) Se esse walker for desligado, ele sai com a base.

### 14. my_role() sem search_path fixo, EXECUTE aberto a PUBLIC, e a recursão que vai aparecer na primeira policy de admin

*Lente: Segurança*

**Problema.** Três problemas distintos na mesma superfície. (1) `my_role()` é SECURITY DEFINER sem `set search_path` — a recomendação do próprio linter do Supabase (`function_search_path_mutable`); uma função definer com search_path herdado resolve `profiles` e `auth.uid()` contra o caminho de quem chama, e basta um objeto sombra em pg_temp ou num schema com CREATE para a função devolver o papel que o atacante quiser. É a diferença entre 'é admin' e 'diz que é admin'. (2) Toda função no schema public nasce com EXECUTE para PUBLIC e é publicada pelo PostgREST como /rest/v1/rpc/<nome>: `expire_stale_reservations`, `current_pricing`, `walkers_for_request` e `cancellation_split` estão todas chamáveis por qualquer portador da anon key. Como o dono decidiu que o app não contém SQL, essa lista de RPCs **é** a superfície de ataque inteira — e hoje ela é acidental, não desenhada. (3) Não há recursão hoje (a policy de profiles não chama my_role()), mas ela chega no dia em que alguém escrever a primeira policy de admin, que é inevitável porque o enum já tem o valor: `create policy "admin vê tudo" on profiles for select using (my_role() = 'admin')` faz my_role() consultar profiles, que avalia a policy, que chama my_role() — erro 42P17, 'infinite recursion detected in policy for relation profiles'. Se a função estiver definer e com search_path, não acontece; se alguém 'simplificar' removendo o definer, a plataforma inteira para de autenticar.

**Como quebra.** 1) Qualquer um com a anon key: POST /rest/v1/rpc/expire_stale_reservations — a função não é definer, então roda com a RLS do chamador, mas um cliente autenticado expira as próprias reservas em 'reserved' (transição válida), escapando da penalidade de cancelamento tardio: em vez de cancelled_client com 50% retidos, a reserva simplesmente 'expira'. 2) POST /rest/v1/rpc/cancellation_split com registro forjado, como no achado próprio. 3) Mais adiante, quando alguém escrever a policy de admin sem entender o mecanismo, o login quebra para todos e o diagnóstico consome as 5h da semana.

### 15. profiles não tem policy de INSERT (o Épico 1 não sobe) e o aceite dos Termos é escrito pelo próprio titular

*Lente: Segurança*

**Problema.** Dois buracos ligados pela mesma causa — dados que provam alguma coisa sendo escritos por quem eles deveriam vincular. (a) profiles tem RLS habilitada e nenhuma policy de INSERT: com RLS ligada e sem policy permissiva, o insert é negado. Logo, ninguém consegue criar o próprio perfil e o Épico 1 trava; e a correção rápida (`for insert with check (id = auth.uid())`) entrega a coluna `role` no cadastro, permitindo nascer admin. (b) `terms_version` e `terms_accepted_at` são colunas comuns preenchidas pelo app no insert, e a decisão 8 do ADR diz que elas existem exatamente para 'provar qual texto valia naquele serviço'. Uma prova que o próprio interessado escreve não prova nada: o texto da versão não vem de lugar nenhum do banco (não existe tabela de Termos), então o valor é uma string arbitrária.

**Como quebra.** 1) Um tutor entra em litígio por um incidente durante um passeio. 2) Antes disso, ou em qualquer momento, ele mandou PATCH /rest/v1/service_requests?id=eq.<X> com `{"terms_version":"v0.9","terms_accepted_at":"2020-01-01T00:00:00Z"}` — a policy de UPDATE do cliente permite. 3) Na disputa, o registro do banco diz que ele aceitou uma versão que não existe, numa data anterior à plataforma. A defesa da plataforma, que era justamente esse registro, vira evidência de que o sistema aceita qualquer coisa. 4) Mesmo sem má-fé: como não há tabela de Termos, o dia em que o app for atualizado com 'v1.1' e um usuário ficar com o APK velho, o banco grava 'v1.0' para um texto que já mudou — e ninguém percebe.

### 16. refresh_walker_rating quebra em DELETE: é impossível apagar a conta de um usuário

*Lente: Segurança*

**Problema.** O trigger é declarado para DELETE, mas a função referencia `new.walker_id`. Em DELETE, `new` não está atribuído — o Postgres levanta 'record "new" is not assigned yet' e a transação inteira falha. Isso transforma uma falha funcional em problema de conformidade, por causa das cascatas: `profiles.id references auth.users on delete cascade` (L40) e `reviews.client_id/walker_id references profiles on delete cascade` (L310-311). Apagar um usuário em auth.users derruba o profile, que tenta derrubar as reviews, que disparam o trigger, que explode. O DELETE é abortado.

**Como quebra.** 1) Um tutor exerce o direito de eliminação previsto no art. 18, VI da LGPD — 'apaguem meus dados'. 2) Você chama a API de admin do Supabase para deletar o usuário. 3) Erro na cascata, a exclusão não acontece. 4) Mesma coisa ao tentar apagar um service_request de teste (`reviews.request_id on delete cascade`, L309) e ao remover um walker que saiu da plataforma. 5) A saída improvisada — desligar o trigger, apagar, religar — é feita sob pressão e sem registro; ou pior, ninguém apaga nada e a base acumula dados de quem pediu para sair, com prazo de resposta correndo (art. 19: 15 dias).

### 17. CPF em claro com índice único numa tabela escrita pelo usuário: oráculo de enumeração e nenhuma trilha de auditoria

*Lente: Segurança*

**Problema.** Dois defeitos estruturais. (a) `profiles.cpf` é unique e a linha é escrita pelo próprio usuário. Uma violação de unique retorna erro 23505 pelo PostgREST com a mensagem do Postgres — o que transforma a constraint num oráculo: dá para testar se um CPF específico está cadastrado na plataforma. O trigger tampouco valida o CPF (só conta 11 dígitos, sem dígito verificador), então '11111111111' passa e a coluna não garante nada. Além disso, CPF só é necessário para walker (é o que o próprio trigger diz), mas a coluna está na tabela de todo mundo — coleta além da finalidade, art. 6º III da LGPD. (b) Nenhuma tabela registra quem mudou o quê. Num sistema onde o cancelamento tem consequência financeira, o walker pode ser suspenso e o preço é snapshot, a ausência de trilha significa que toda disputa entre tutor e walker é decidida no 'quem fala mais alto', e que qualquer um dos ataques acima é indetectável depois do fato.

**Como quebra.** Oráculo: 1) O atacante quer saber se uma pessoa específica usa o Quati Walker. 2) PATCH /rest/v1/profiles?id=eq.<meu uuid> com `{"cpf":"<CPF do alvo>"}`. 3) Resposta 409 com 'duplicate key value violates unique constraint' → o CPF está cadastrado, o alvo é usuário da plataforma. Resposta 200 → não está (e ele desfaz com outro PATCH). 4) Repetindo com a lista de CPFs de uma base vazada qualquer, ele mapeia quem em Foz usa o serviço.

Auditoria: 1) Um walker altera `payout_cents` de um serviço (achado 1) e recebe R$ 40 em vez de R$ 32. 2) O tutor reclama, o walker nega. 3) Não existe registro de valor anterior, de autor nem de horário — `service_requests` nem tem trigger de updated_at (t1..t4, L494-497, não incluem essa tabela). 4) Sem prova, você paga os dois lados ou perde um walker num mercado de cinco.

### 18. A distância exata devolvida pelo matching permite trilaterar a casa do walker

*Lente: Operação*

**Problema.** O ADR, decisão 6, afirma que a função 'devolve distância, nunca coordenada' e conclui que 'localização de pessoa não vaza'. Três pedidos em endereços diferentes, com a distância em metros para o mesmo walker_id, determinam a posição dele com erro de poucos metros. Criar pedidos é gratuito e o walker_id é estável entre chamadas.

**Como quebra.** Um walker relata que está sendo seguido, ou que alguém apareceu na casa dele. Você não tem como afirmar que não veio do seu app — veio. E não há registro de quem chamou walkers_for_request, quando, e para qual ponto.

### 19. Início e fim do serviço não registram posição — disputa de 'o passeio não aconteceu' é indecidível

*Lente: Operação*

**Problema.** O ADR joga rastreamento em segundo plano para a fase 2, e está certo. Mas gravar dois pontos — um no start, um no end — não é rastreamento e resolve a maioria das disputas. Hoje não existe nem isso, e walker_locations sobrescreve a última posição, então nem a localização do momento do serviço sobrevive.

**Como quebra.** 'O passeio durou 4 minutos.' completed_at - started_at confirma: 4 minutos. E daí? Foi o walker que apertou o botão errado, foi o cão que passou mal na esquina, ou o serviço nunca saiu do portão? Você não tem base para decidir entre estornar R$ 40 (e perder a margem de um serviço talvez prestado) ou não estornar (e perder o cliente). Decide no chute, nos dois sentidos, para sempre.

### 20. A view clients_pay_first agrega a tabela inteira para responder sobre um cliente — e roda na criação de cada pedido

*Lente: Operação*

**Problema.** A view agrupa todos os 'expired' dos últimos 30 dias, da base inteira, para responder uma pergunta sobre um único cliente. Nenhum índice cobre (client_id, cancelled_at) where status = 'expired'; o (status, scheduled_at) da linha 192 não serve, porque o predicado é sobre cancelled_at. Some-se um detalhe confuso: a expiração grava a data em cancelled_at (linhas 243-244), então a coluna guarda duas coisas com nomes diferentes.

**Como quebra.** A regra anti-abuso da decisão 3 precisa ser consultada no momento de criar o pedido — é o botão mais usado do app. No mês 8, com 12 mil pedidos, cada toque em 'Solicitar' dispara um seq scan com agregação. A tela fica com 800 ms de latência e você jamais vai suspeitar de uma view de anti-abuso escrita no épico 0.

### 21. Índices não cobrem as duas telas mais usadas, e my_role() é avaliada uma vez por linha nas policies

*Lente: Operação*

**Problema.** (a) Não há índice para 'meus serviços ativos' (walker_id = x and status in ('reserved','confirmed','in_progress')) — o índice (walker_id, created_at desc) ordena por data e não filtra status. (b) Os índices não são parciais, então carregam para sempre todos os 'completed', que são a grande maioria e nunca são consultados por essas telas. (c) my_role() chamada direto na policy é reavaliada por linha; o padrão do Supabase é envolver em subselect para virar InitPlan avaliado uma vez. (d) Os índices não têm nome explícito, o que torna qualquer migration futura um exercício de adivinhação de nome gerado.

**Como quebra.** A tela inicial do walker é a consulta mais chamada do app. Com 20 mil linhas ela faz bitmap heap scan mais filtro, e para cada linha candidata reavalia my_role(), que é um select em profiles. São milhares de consultas para desenhar uma lista de 5 itens, num Android modesto numa rede 4G de Foz. A lentidão aparece devagar, ao longo de meses, e nunca chega a virar um bug reportável.

### 22. Funções SECURITY DEFINER sem search_path fixo — inclusive a que decide autorização

*Lente: Operação*

**Problema.** Uma função SECURITY DEFINER sem search_path fixo resolve nomes de objeto pelo search_path de quem chama. O linter do Supabase reporta isso como function_search_path_mutable e é um vetor conhecido de escalada. my_role() é o pior lugar possível para esse descuido: ela decide autorização em três policies (linhas 426, 434 e, indiretamente, tudo que depende delas).

**Como quebra.** Você nunca vai ver isso quebrar num sábado — vai ver no Security Advisor do Supabase, em vermelho, no dia em que for procurar outra coisa, sem saber se é grave. É barato de corrigir hoje e caro de auditar depois, com oito épicos construídos em cima.

---

## Baixo (2)

### 1. Faltam pequenas travas de integridade: updated_at, agendamento no passado, e search_path das SECURITY DEFINER

*Lente: Negócio*

**Problema.** Três pontas soltas. (a) `service_requests` e `reviews` não têm trigger `touch_updated_at`: `service_requests.updated_at` só avança dentro de `assert_status_transition`, então qualquer update que não mude status deixa o carimbo mentindo. (b) `scheduled_at` não tem check de futuro — um pedido para ontem é aceito, e `cancellation_split` com `horas` negativo cai no ramo de 50% sem que ninguém tenha pedido isso. (c) `my_role()` é `security definer` sem `set search_path`; num banco Supabase onde o usuário pode criar objetos em schemas no path, isso é o padrão de ataque clássico contra função definer.

**Como quebra.** (a) Auditoria de um incidente: a linha mostra `updated_at` de três semanas atrás, embora `refund_cents` tenha sido alterado ontem. (b) Cliente cria pedido com `scheduled_at` de ontem por bug de fuso no app (Expo, timezone do device), walker aceita, cliente paga, e o cancelamento devolve 50% em vez de 100%. (c) Usuário cria uma função `profiles` num schema que esteja antes de `public` no search_path e faz `my_role()` retornar 'admin'.

### 2. Telefone e e-mail sem normalização nem índice: a busca do suporte não encontra o cliente

*Lente: Operação*

**Problema.** Fora o CPF, que é unique, não há índice nenhum em profiles para busca. E phone é gravado exatamente como o usuário digitou, sem máscara padronizada.

**Como quebra.** 23h de sábado. A única informação que o cliente te dá no WhatsApp é o número dele. Você tenta select * from profiles where phone = '45999990000' e não vem nada, porque no banco está '(45) 99999-0000'. Tenta com ilike e curinga: seq scan, e ainda assim erra se ele gravou com +55. Você acaba procurando pelo primeiro nome, acha três pessoas e não sabe qual é. Dez minutos perdidos num problema que é uma coluna gerada.

---

## O que mudou na versão 2.0

As correções foram agrupadas em oito mudanças estruturais:

1. **O app perdeu permissão de escrita.** `revoke` em todas as tabelas de negócio; toda escrita passa por função RPC (`0002_rpc.sql`). Sozinha, esta mudança resolve 21 dos 29 críticos.
2. **Trigger de INSERT.** Preço, comissão, repasse, estado inicial, versão dos Termos e snapshot do animal passaram a ser derivados pelo servidor.
3. **Trigger de UPDATE com colunas congeladas.** O que nasce com a solicitação nunca muda; carimbos e valores de fechamento só o trigger escreve.
4. **Escalonamento de papel fechado.** Trigger-guarda em `profiles` e em `walker_profiles`: ninguém vira admin, se autoverifica, se dessuspende nem forja a própria nota.
5. **Vazamento de endereço e de posição fechado.** O walker recebe faixa de distância e bairro; o endereço só aparece depois do aceite. A distância exata sumiu — três consultas permitiam trilaterar a casa de alguém.
6. **O dinheiro fecha.** `final_commission_cents` passou a existir (é a base da nota fiscal), o split do cancelamento é calculado no trigger, e há tabela de estorno para o reembolso de 50%.
7. **Passou a existir o que faltava:** trilha de eventos, custódia de chave, incidentes, estornos, validade da vacina, snapshot do animal, anonimização para a LGPD.
8. **Corridas e webhooks.** Exclusion constraint contra dois serviços no mesmo horário, `where status = 'requested'` no aceite, e ranking de status que impede webhook fora de ordem rebaixar um pagamento aprovado.

---

## Verificação em banco real — 12/09/2026

O schema v2 foi carregado num PostgreSQL 15.8 + PostGIS 3.4 e submetido aos 18
testes de `tests/01_smoke.sql`. **Resultado: 18/18.**

A auditoria por leitura não é suficiente: rodar de verdade encontrou mais seis
defeitos, todos invisíveis na revisão.

| # | Defeito | Por que só aparece ao executar |
|---|---|---|
| 1 | `my_role()` criada antes de `profiles` existir | Função `language sql` tem o corpo validado na criação. O arquivo inteiro abortava na linha 50. |
| 2 | Coluna gerada `service_window` rejeitada | `timestamptz + interval` é STABLE, não IMMUTABLE, porque depende do fuso da sessão. Virou coluna comum preenchida pelo trigger. |
| 3 | `search_path` vazio escondia o PostGIS | Com `search_path = ''`, o tipo `geography` e as funções `st_*` não resolvem. Passou a `pg_catalog, public, extensions` — continua fixo, que é a propriedade de segurança que importa. |
| 4 | `service_role` sem privilégio nas tabelas | No Supabase hospedado ele já nasce com eles; num Postgres limpo, não. Os `grant` passaram a constar da migration. |
| 5 | `current_user` dentro de `SECURITY DEFINER` é o dono | As funções `server_*` achavam que estavam sendo chamadas por outra pessoa. Deixaram de ser definer. |
| 6 | Os triggers-guarda bloqueavam o próprio sistema | A média do walker nunca era gravada: o guarda revertia a escrita. A condição passou a nomear os papéis do app (`authenticated`, `anon`) em vez de negar todos menos `service_role`. |

O defeito 6 é o mais instrutivo: a proteção estava correta na intenção e errada
no alcance — barrava o atacante e, junto, o sistema. Nenhuma leitura pegou isso.
