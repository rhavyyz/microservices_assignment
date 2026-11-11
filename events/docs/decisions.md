# Serviço de Eventos — decisões de implementação (DE-1 a DE-7)

As decisões principais já estavam tomadas no design da equipe (padrões marcados em verde no diagrama). Este
documento mostra como cada uma foi aplicada no serviço de Eventos e registra as decisões **adicionais** que a
implementação exigiu (DE-1 a DE-7). O DE-7 atualiza os contratos vivos: onde ele substitui uma decisão anterior, a
decisão antiga mantém o texto original e ganha uma "Nota (substituída)".

## Escopo herdado do design

O agrupamento do design coloca no serviço de Eventos: **Eventos** (RF02), **Programação** (RF03), **Consulta e busca**
(RF04) e **Capacidade** (parte de RF06). A lista de espera ficou com o serviço de Inscrições ("a lógica de capacidade
ficasse em eventos e a lógica de lista de espera em inscrições"). Do modelo de dados do design: evento com título,
responsável (id do usuário), capacidade imutável, valor de inscrição e metadados; item da programação com evento,
início, fim e descrição.

## Padrões do design e onde aparecem

| Padrão (verde no design) | Aplicação no serviço de Eventos |
|---|---|
| Database per Service | PostgreSQL próprio (`events-db`), só na rede `events-net`; nenhum outro serviço lê suas tabelas. |
| API Gateway | Rotas de negócio em `/api/v1/...`, expostas como `/events/api/v1/...` pelo Gateway; `GET /openapi.json` alimenta a tabela de endpoints; script abre as rotas. |
| Server-side discovery | Registro como `events` no service-discoverer (registro único ao iniciar, pela biblioteca compartilhada); Inscrições resolve `events` por ele. |
| Access Token | O Gateway verifica o JWT e envia `X-User-Id` / `X-User-Roles`; Eventos confia nesses cabeçalhos (DE-7; a validação local do DE-4 foi substituída). |
| Messaging (Kafka) | Só publica, em `events.events`: `Event*`, `Activity*` (DE-7). Não consome nada. |
| Saga / consistência de dados | Eventos guarda só a capacidade máxima; a saga de reserva de vaga (DE-2) saiu e Inscrições conta as vagas (DE-7). |
| Idempotent Consumer | Não se aplica mais a Eventos (não consome). A tabela `processed_messages` ficou no banco, sem uso. |
| Health check API | `GET /healthcheck`: 200 só com schema migrado e banco respondendo. |
| Audit logging | Uma linha estruturada (`audit: true`) por operação de escrita, inclusive recusas, e por atividade encerrada automaticamente (sem usuário). |
| Exception tracking | Erros em `application/problem+json` com `code` e `traceId` (= `X-Trace-Id`); 500 genérico, detalhe só no log. |
| Querying (CQRS/API Composition) | Eventos publica o estado completo de eventos e atividades nas mensagens, para projeções de leitura (ex.: Relatórios). |

---

## DE-1 — Capacidade e preço por atividade; capacidade imutável

- **Estado:** Proposto (diverge do esboço de dados do design; ver justificativa)
- **Contexto:** o esboço de dados do design põe `Capacidade` e `valor de inscrição` no **evento**. A especificação diz que
  "um evento pode conter várias atividades, com datas, horários, preços e capacidades diferentes", que algumas atividades
  são gratuitas e outras pagas, e RN01 fala em "capacidade da atividade". O serviço de Relatórios, já implementado pela
  equipe, consome `activity.created` com `capacity` e `paid` por atividade. O check-in do design também referencia o item
  da programação. O design define ainda que a capacidade não pode ser alterada após a criação.
- **Alternativas:** (a) capacidade e preço só no evento, como no esboço; (b) nos dois níveis (limite global + por
  atividade); (c) só na atividade.
- **Decisão:** (c). A atividade (item da programação) é a unidade de inscrição, capacidade e preço. `capacity` é imutável
  depois de criada (regra do design, generalizada para a atividade), garantida por gatilho no banco e pela API, que rejeita
  o campo no `PATCH`. O preço (`price_cents`, inteiro em centavos — o design pede `int`) só muda enquanto o evento é
  rascunho. Um evento com uma única atividade reproduz o caso do esboço.
- **Evidências:** testes "capacity is immutable even for a direct database write" e "after publishing, the price is fixed"
  (integração, PostgreSQL real); contrato de mensagens do serviço de Relatórios.
- **Justificativa:** é a única opção compatível com a especificação e com o contrato já consumido por Relatórios. (b)
  duplica a regra de vagas em dois níveis sem requisito que peça isso. Capacidade imutável elimina a corrida "reduzir a
  capacidade abaixo do já reservado".
- **Consequências:** Inscrições referencia `activity_id` (além de `event_id`), o que deve ser refletido no modelo de
  inscrição do design. Mudar a capacidade exige criar outra atividade.
- **Nota (nomes):** hoje o preço se chama `amount_minor` na API e nas mensagens (a coluna do banco continua `price_cents`) e
  as mensagens seguem o formato de Inscrições (DE-7). O resto da decisão vale.

## DE-2 — Reserva de vaga por coreografia assíncrona com UPDATE condicional atômico

- **Nota (substituída):** esta decisão foi substituída pelo DE-7. Eventos não conta mais vagas: a saga
  (`registration.*` → `seat.*`), o consumidor Kafka, `reserved`/`available`, `seat_reservations` e `processed_messages` não são
  mais usados (as colunas e tabelas ficam no banco, sem uso). Inscrições conta as vagas contra a `capacity` que Eventos
  informa. O texto abaixo é o histórico da decisão original.
- **Estado:** Proposto (define o contrato que o serviço de Inscrições deve seguir)
- **Contexto:** a capacidade fica em Eventos e a inscrição em Inscrições, então reservar uma vaga é uma transação entre
  serviços (Database per Service). O design adotou Messaging e Saga; RPC não foi marcado. RN01/RQ04 exigem zero
  overbooking mesmo sob concorrência e a abertura de inscrições tem pico de 20× (RQ02).
- **Alternativas:** (a) chamada HTTP síncrona `POST /reserve` de Inscrições para Eventos; (b) saga orquestrada por um
  serviço coordenador; (c) coreografia por eventos: Inscrições publica `registration.requested` e Eventos responde
  `seat.reserved`/`seat.rejected`. Para o controle de vagas: (1) `SELECT ... FOR UPDATE` + verificação na aplicação;
  (2) contador com UPDATE condicional; (3) nível de isolamento SERIALIZABLE com retentativas.
- **Decisão:** (c) + (2). Eventos consome `registration.requested`/`cancelled`/`expired` e responde pelo outbox. A vaga é
  tomada por um único comando: `UPDATE activities SET reserved = reserved + 1 WHERE id = $1 AND event publicado AND
  atividade não começou AND reserved < capacity`. Uma restrição `CHECK (reserved BETWEEN 0 AND capacity)` é a última
  barreira. `seat_reservations` registra quem detém vaga, tornando reserva e liberação idempotentes por inscrição; uma
  trava consultiva (`pg_advisory_xact_lock`) serializa as mensagens da mesma inscrição mesmo que cheguem por partições
  diferentes.
- **Evidências:** teste de concorrência (200 pedidos simultâneos, 25 vagas → exatamente 25 reservadas e 175 `FULL`,
  contador igual ao número de reservas); teste com liberações e novos pedidos concorrentes, incluindo liberações
  duplicadas. Ambos contra PostgreSQL 16 real.
- **Justificativa:** o PostgreSQL bloqueia a linha da atividade e reavalia `reserved < capacity` na versão mais nova antes
  de aplicar cada UPDATE, então a corretude não depende de código da aplicação. Uma única instrução segura a trava pelo
  menor tempo possível (melhor que (1) no pico) e não gera falhas de serialização a reprocessar (3). A coreografia mantém
  Eventos disponível para leitura mesmo com Inscrições fora do ar e evita um coordenador a mais (b); (a) acoplaria a
  disponibilidade de Inscrições à de Eventos a cada pedido.
- **Consequências:** a inscrição fica `PENDING` até a resposta chegar (consistência eventual, latência do broker).
  Inscrições precisa tratar `seat.rejected` (lista de espera se `waitlist_enabled`), `seat.released` (oferecer a vaga ao
  próximo — RN04) e `event.cancelled`. Uma reserva pendente de pagamento ocupa vaga até Inscrições/Pagamentos publicar
  `registration.expired` (RN02/RN03): o prazo de expiração pertence a eles.

## DE-3 — Transactional Outbox para publicar mensagens

- **Estado:** Proposto (padrão listado no design como sugestão, não marcado em verde)
- **Contexto:** toda mudança relevante precisa virar mensagem: Relatórios constrói sua projeção a partir delas e
  Inscrições depende das respostas de vaga. Gravar no banco e depois publicar no Kafka são duas operações: se a segunda
  falhar após a primeira, a mensagem se perde; publicar antes do commit pode anunciar uma mudança que sofreu rollback.
  RQ04 pede transições "controladas e recuperáveis"; RQ03 pede que falhas de dependências não bloqueiem a operação.
- **Alternativas:** (a) publicar após o commit, com retentativas em memória; (b) publicar antes do commit; (c) outbox na
  mesma transação + relay; (d) CDC lendo o log do banco (Debezium).
- **Decisão:** (c). Cada caso de uso grava a mudança e as mensagens na tabela `outbox` na mesma transação (`unit-of-work`).
  Um relay lê as pendentes em ordem (`seq`), publica com produtor idempotente e marca como publicadas. Uma trava
  consultiva garante um único relay ativo entre réplicas, preservando a ordem. Publicadas são apagadas após 24 h.
- **Evidências:** testes do relay: ordem preservada, falha do broker deixa o lote pendente e o reenvio usa o mesmo
  `message_id`, mudança com rollback nunca chega ao outbox, dois relays simultâneos nunca publicam a mesma mensagem.
- **Justificativa:** (a) perde mensagens em queda do processo e deixaria uma inscrição pendente para sempre; (b) publica
  fatos que não aconteceram; (d) adiciona infraestrutura pesada para um protótipo. Com (c) o Kafka fora do ar só atrasa as
  mensagens: a API continua aceitando escritas.
- **Consequências:** entrega *at-least-once*: consumidores precisam deduplicar por `message_id` (Relatórios já faz; o
  próprio Eventos fazia com `processed_messages`). Latência extra de até `OUTBOX_INTERVAL_MS` (500 ms). Uma tabela a mais.
- **Nota:** o outbox continua valendo; o encerramento automático (DE-7) também grava nele, na mesma transação da mudança.
  Eventos não consome mais mensagens, então a parte de consumidor idempotente deixou de existir.

## DE-4 — Access Token validado localmente; RN07 como 404

- **Nota (substituída):** a validação do JWT no próprio serviço (JWKS, verificador de token, `JWT_*`, `AUTH_UNAVAILABLE`)
  foi substituída pelo DE-7: a identidade vem só dos cabeçalhos `X-User-Id` / `X-User-Roles` do Gateway. Seguem valendo o
  papel `ORGANIZER` para criar evento, a posse do evento para alterar e o **404** para recursos alheios (RN07). O texto
  abaixo é o histórico da decisão original.
- **Estado:** Proposto (alinha com a pendência P3 do serviço de Usuários)
- **Contexto:** o Gateway só verifica a presença de `X-User-Id`, sem validar identidade; qualquer cliente pode enviar esse
  cabeçalho. O serviço de Usuários emite JWT RS256 (`sub`, `roles`, `iss`, `exp`) e publica a chave em
  `/.well-known/jwks.json`. RN07: organizadores administram apenas os próprios eventos.
- **Alternativas:** (a) confiar em `X-User-Id`; (b) introspecção do token no serviço de Usuários a cada requisição;
  (c) validar a assinatura localmente com o JWKS em cache.
- **Decisão:** (c). Só `RS256` é aceito (rejeita `alg: none` e truques HMAC); exige `iss`, `exp`, `sub`. Chaves em cache
  por 5 min; um `kid` desconhecido força nova busca no máximo a cada 10 s (rotação). Se Usuários estiver fora do ar, as
  chaves em cache continuam valendo; sem nenhuma chave, 503. Criar evento exige o papel `ORGANIZER`; alterar exige ser o
  `organizer_id`. Evento de outro organizador responde **404**, igual a inexistente. Rascunhos só aparecem ao dono.
- **Evidências:** testes de token: válido, forjado, adulterado, expirado, emissor errado, `alg none`/HS256, rotação de
  chave, Usuários indisponível; testes de integração de RN07 em todas as operações de escrita.
- **Justificativa:** (a) permite se passar por qualquer organizador; (b) acopla cada leitura e escrita à disponibilidade
  de Usuários (RQ03) e adiciona latência no pico (RQ02). O 404 não revela a existência de eventos alheios.
- **Consequências:** revogação antes do `exp` não é suportada (validade curta do token mitiga). As rotas ficam com
  `requireAuth=false` no Gateway, pois a autenticação é feita no serviço.
- **Atualização (P3, após o merge de Usuários):** a equipe decidiu que o Gateway passará a validar o JWT e a escrever o
  `X-User-Id` com o `sub` (substituindo o enviado pelo cliente); serviços que só precisam do id do usuário podem depender
  desse cabeçalho. Eventos **continua validando o Bearer** porque precisa de `roles` (criar evento exige `ORGANIZER`) e o
  cabeçalho só carrega o id; a validação dupla é barata (chave em cache) e vale como defesa em profundidade. Requisito
  para o Gateway: **continuar repassando o cabeçalho `Authorization`** (ou passar a injetar também os papéis). Quando a
  mudança estiver no ar, as rotas de escrita podem ir para `requireAuth=true` e `rateLimitBy=user_or_ip` (ver
  `scripts/register-gateway-routes.sh`); antes disso, `requireAuth=true` recusaria clientes que só enviam o Bearer.

## DE-5 — TypeScript, Fastify, PostgreSQL e kafkajs

- **Estado:** Aceito
- **Contexto:** a especificação pede ao menos duas tecnologias entre os serviços; já existem Go (Gateway, Notificações,
  discoverer), Java/Spring (Usuários) e TypeScript (Relatórios). A orientação foi usar TypeScript sempre que possível.
- **Alternativas:** Java/Spring como Usuários; Go como Notificações; TypeScript com a mesma pilha de Relatórios.
- **Decisão:** TypeScript (Node 22) com Fastify, `@fastify/swagger`, `pg` e `kafkajs` — exatamente as dependências e o
  Dockerfile de Relatórios. PostgreSQL pelo suporte a transações, travas de linha, `CHECK`, gatilhos e colunas geradas,
  que sustentam DE-2 e DE-3.
- **Justificativa:** reaproveita o que a equipe já conhece e mantém (build, testes com `node:test`, formato de mensagens,
  migração com trava consultiva). Os schemas JSON do Fastify validam entrada, filtram a saída e geram o `openapi.json`
  que o Gateway consome, de uma só fonte.
- **Consequências:** não há biblioteca TypeScript do discoverer (o protocolo é usado direto, como em Relatórios); o
  código de registro poderia virar `service-discoverer/Libs/typescript` e ser compartilhado pelos dois serviços.
  *Atualização:* essa biblioteca passou a existir e Eventos a usa (pacote `discovery`); o cliente próprio foi removido. Eventos agora usa a biblioteca TypeScript compartilhada e se registra uma única vez ao iniciar, com as tentativas padrão da biblioteca; não se registra mais periodicamente.

## DE-6 — Contrato de erros e de correlação

- **Estado:** Aceito
- **Contexto:** RQ06 pede rastrear uma inscrição entre componentes e diagnosticar falhas. O Gateway gera/propaga
  `X-Request-Id`; Usuários responde erros em `application/problem+json` com `code` e `traceId`.
- **Decisão:** mesmo formato de erro de Usuários. O id da requisição é o `X-Request-Id` do Gateway quando bem formado
  (senão um UUID novo); vai nos logs, no `traceId` dos erros e no `correlation_id` das mensagens geradas. Ao consumir uma
  mensagem, o `correlation_id` recebido é propagado para as respostas. Campos desconhecidos no corpo são rejeitados (400)
  em vez de ignorados.
- **Consequências:** um erro reportado pelo usuário leva à linha de log exata; uma inscrição pode ser seguida de
  Inscrições a Eventos e de volta pelo mesmo id.
- **Nota (renomeação):** o cabeçalho `X-Request-Id` citado acima passou a se chamar `X-Trace-Id` e o "id da requisição" a
  "trace id" (`traceId`); `X-Request-Id` recebido é ignorado e não é devolvido. O texto acima é mantido como foi decidido.
  Do mesmo modo, o `correlation_id` das mensagens Kafka (e o cabeçalho `correlation-id`) passou a se chamar `trace_id`
  (cabeçalho `trace-id`); uma mensagem consumida que só traz `correlation_id` é aceita, mas o campo é ignorado (`trace_id` fica `null`).
- **Nota (substituída em parte):** Eventos não consome mais mensagens (DE-7), então a propagação do identificador de uma
  mensagem consumida deixou de existir; o `trace_id` das mensagens publicadas é o `X-Trace-Id` da requisição, ou `null` no
  encerramento automático. O envelope agora é plano, com `schema_version` no lugar de `version`.

## DE-7 — Eventos guarda só a capacidade; ciclo de vida da atividade; identidade pelo cabeçalho; nomes de Inscrições

- **Estado:** Aceito
- **Contexto:** Inscrições já implementa o contrato de integração (`subscription/CONTRACTS.md`): conta ela mesma as vagas
  contra a `capacity` que lê de Eventos, consulta `registration_open`/`amount_minor` em `GET /api/v1/activities/{activity_id}`,
  pergunta `permissions/me` antes de cada operação administrativa, consome `events.events` (inclusive `ActivityEnded` e
  `ActivityCancelled`, que aplica sob o relógio dela e recusa quando antecipados) e recebe a identidade do Gateway por
  `X-User-Id` / `X-User-Roles`. O Eventos original tinha o modelo antigo (saga de reserva, JWT validado localmente, nomes e
  tópicos próprios).
- **Alternativas:** manter a saga de vagas em Eventos e adaptar só os nomes; manter a validação do JWT e aceitar também o
  cabeçalho; encerrar atividades só pelo organizador; ou só automaticamente.
- **Decisão:**
  1. **Capacidade.** Eventos guarda só a capacidade máxima (imutável); Inscrições conta as vagas ocupadas. A saga de reserva
     sai: sem consumidor Kafka, sem `seat.*`, sem `SUBSCRIPTION_TOPIC` nem grupo de consumo, sem ler ou gravar `reserved`,
     `available` e `seat_reservations`. O banco **não** perde colunas nem tabelas (`reserved`, `available`,
     `seat_reservations`, `processed_messages` ficam sem uso). `available` some da API e das mensagens.
  2. **Ciclo de vida da atividade.** Nova coluna `activities.ended_at` (nula). O `lifecycle` é derivado: `CANCELLED` se o
     evento está cancelado, senão `ENDED` se `ended_at` existe, senão `OPEN`. O organizador encerra a atividade
     (`POST /api/v1/activities/{activity_id}/end`) depois do `ends_at` previsto (antes disso, 409 `ACTIVITY_NOT_ENDED`,
     porque Inscrições recusa um `ActivityEnded` antecipado e travaria o consumidor); repetir é idempotente e não publica de
     novo. Um job automático encerra, `ACTIVITY_AUTO_END_AFTER_SECONDS` (padrão um dia) depois do `ends_at`, o que ninguém
     encerrou, em lotes com `FOR UPDATE SKIP LOCKED` (seguro com várias réplicas), publicando `ActivityEnded` na mesma
     transação. Cancelar o evento cancela as atividades: publica `EventCancelled` e um `ActivityCancelled` por atividade ainda
     não encerrada. Encerrada ou cancelada, a atividade continua consultável; `registration_open` fica falso.
  3. **Identidade.** Só `X-User-Id` (UUID; presente e inválido é 401, ausente é anônimo) e `X-User-Roles` (separados por
     vírgula, comparados em maiúsculas), como nos outros serviços. O JWT e o JWKS saem do serviço (`JWT_ISSUER`,
     `JWT_JWKS_URL`, `JWKS_CACHE_SECONDS`, o verificador e a chamada a Usuários). O serviço confia nos cabeçalhos por
     isolamento de rede; o Gateway apaga os cabeçalhos enviados pelo cliente. As rotas de escrita passam a `requireAuth=true`.
  4. **Nomes alinhados a Inscrições.** HTTP em `/api/v1`, parâmetros e campos `event_id`/`activity_id`, `amount_minor` e
     `currency`; tópico `events.events`; envelope plano com `schema_version`; tipos em PascalCase; chave = `event_id` nas
     mensagens de evento e de criação/edição/remoção de atividade e `activity_id` em `ActivityEnded`/`ActivityCancelled`.
- **Evidências:** testes unitários das regras do `end` (dono, evento publicado, antes do `ends_at`, sucesso uma vez,
  repetição sem mensagem), do cancelamento que publica `ActivityCancelled`, do job (só vencidas, uma vez, `trace_id` nulo,
  sem sobreposição), da identidade por cabeçalho e do envelope; testes de integração das mesmas regras contra PostgreSQL.
- **Justificativa:** quem registra as inscrições é quem conta as vagas sem corrida entre serviços; manter o contador em
  Eventos obrigaria a saga assíncrona e duplicaria a regra. Deixar o fim da atividade só por conta do organizador travaria
  quem esquece, e só automático tiraria o controle dele; os dois caminhos publicam a mesma mensagem. Confiar nos cabeçalhos
  evita verificar o JWT duas vezes e a dependência de Usuários, com o mesmo modelo de confiança dos demais serviços.
- **Consequências:** Relatórios ainda lê o formato antigo (`event.created`, `data` aninhado) e deixa de projetar eventos e
  atividades até ser adaptado (aceito). O serviço só é seguro atrás do Gateway e da rede interna. Uma atividade de um evento
  cancelado mostra `CANCELLED` mesmo que tivesse encerrado antes (o `ended_at` permanece). Mensagens ainda pendentes no outbox
  no momento da atualização saem no formato antigo.

---

## Integração com o restante da equipe

| Serviço | O que precisa saber |
|---|---|
| Inscrições | Conta as vagas contra a `capacity`; lê `GET /api/v1/activities/{activity_id}` e `.../permissions/me`; consome `events.events` (`EventCancelled`, `Activity*`) (DE-7). |
| Relatórios | Ainda lê o formato antigo (`event.*`, `data` aninhado, `events-events`) e deixa de projetar até ser adaptado (aceito; DE-7). |
| Notificações | Eventos não conhece os inscritos; avisar participantes sobre `EventUpdated`/`EventCancelled` (RF08) cabe a Inscrições, que traduz para o tópico `notifications`. |
| Gateway | Rodar `events/scripts/register-gateway-routes.sh` após o primeiro sync; o Gateway verifica o JWT e envia `X-User-Id` / `X-User-Roles`. |
| Usuários | Nenhuma chamada: Eventos recebe só o `sub` e os papéis pelos cabeçalhos do Gateway (DE-7). |

## Limitações conhecidas
- `reserved`, `available`, `seat_reservations` e `processed_messages` ficam no banco sem uso (a migração é não destrutiva); removê-las é uma migração futura.
- Sem cache de leitura: no pico de RQ02 a escala é por réplicas (`deploy.replicas`) e índices; as consultas públicas são
  simples e indexadas.
- O layer HTTP (Fastify) e o Kafka não puderam ser executados no ambiente onde o serviço foi escrito (sem acesso ao
  registro npm); foram verificados por checagem de tipos estrita, testes unitários das partes puras e pela suíte de
  integração dos casos de uso contra PostgreSQL real.
