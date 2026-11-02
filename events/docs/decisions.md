# Serviço de Eventos — decisões de arquitetura

As decisões principais já estavam tomadas no design da equipe (padrões marcados em verde no diagrama). Este
documento mostra como cada uma foi aplicada no serviço de Eventos e registra as decisões **adicionais** que a
implementação exigiu (ADR-E1 a ADR-E6).

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
| API Gateway | Rotas expostas como `/events/...` pelo Gateway; `GET /openapi.json` alimenta a tabela de endpoints; script abre as rotas. |
| Server-side discovery | Registro como `events` no service-discoverer (re-registro a cada 30 s); a chave pública do serviço de Usuários é localizada via `consult`. |
| Access Token | JWT RS256 emitido pelo serviço de Usuários, validado localmente com o JWKS (ADR-E4). |
| Messaging (Kafka) | Publica `event.*`, `activity.*`, `seat.*` em `events-events`; consome `registration.*` de `subscription-events`. |
| Saga / consistência de dados | Lado de capacidade da saga de inscrição, coreografada por mensagens (ADR-E2). |
| Idempotent Consumer | `processed_messages` gravada na mesma transação do efeito + trava por inscrição. |
| Health check API | `GET /healthcheck`: 200 só com schema migrado e banco respondendo. |
| Audit logging | Uma linha estruturada (`audit: true`) por operação de escrita, inclusive recusas. |
| Exception tracking | Erros em `application/problem+json` com `code` e `traceId` (= `X-Request-Id`); 500 genérico, detalhe só no log. |
| Querying (CQRS/API Composition) | Eventos publica o estado completo de eventos e atividades nas mensagens, para projeções de leitura (ex.: Relatórios). |

---

## ADR-E1 — Capacidade e preço por atividade; capacidade imutável

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

## ADR-E2 — Reserva de vaga por coreografia assíncrona com UPDATE condicional atômico

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

## ADR-E3 — Transactional Outbox para publicar mensagens

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
  próprio Eventos faz com `processed_messages`). Latência extra de até `OUTBOX_INTERVAL_MS` (500 ms). Uma tabela a mais.

## ADR-E4 — Access Token validado localmente; RN07 como 404

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

## ADR-E5 — TypeScript, Fastify, PostgreSQL e kafkajs

- **Estado:** Aceito
- **Contexto:** a especificação pede ao menos duas tecnologias entre os serviços; já existem Go (Gateway, Notificações,
  discoverer), Java/Spring (Usuários) e TypeScript (Relatórios). A orientação foi usar TypeScript sempre que possível.
- **Alternativas:** Java/Spring como Usuários; Go como Notificações; TypeScript com a mesma pilha de Relatórios.
- **Decisão:** TypeScript (Node 22) com Fastify, `@fastify/swagger`, `pg` e `kafkajs` — exatamente as dependências e o
  Dockerfile de Relatórios. PostgreSQL pelo suporte a transações, travas de linha, `CHECK`, gatilhos e colunas geradas,
  que sustentam ADR-E2 e ADR-E3.
- **Justificativa:** reaproveita o que a equipe já conhece e mantém (build, testes com `node:test`, formato de mensagens,
  migração com trava consultiva). Os schemas JSON do Fastify validam entrada, filtram a saída e geram o `openapi.json`
  que o Gateway consome, de uma só fonte.
- **Consequências:** não há biblioteca TypeScript do discoverer (o protocolo é usado direto, como em Relatórios); o
  código de registro poderia virar `service-discoverer/Libs/typescript` e ser compartilhado pelos dois serviços.

## ADR-E6 — Contrato de erros e de correlação

- **Estado:** Aceito
- **Contexto:** RQ06 pede rastrear uma inscrição entre componentes e diagnosticar falhas. O Gateway gera/propaga
  `X-Request-Id`; Usuários responde erros em `application/problem+json` com `code` e `traceId`.
- **Decisão:** mesmo formato de erro de Usuários. O id da requisição é o `X-Request-Id` do Gateway quando bem formado
  (senão um UUID novo); vai nos logs, no `traceId` dos erros e no `correlation_id` das mensagens geradas. Ao consumir uma
  mensagem, o `correlation_id` recebido é propagado para as respostas. Campos desconhecidos no corpo são rejeitados (400)
  em vez de ignorados.
- **Consequências:** um erro reportado pelo usuário leva à linha de log exata; uma inscrição pode ser seguida de
  Inscrições a Eventos e de volta pelo mesmo id.

---

## Integração com o restante da equipe

| Serviço | O que precisa saber |
|---|---|
| Inscrições | Publicar `registration.requested`/`cancelled`/`expired` em `subscription-events` com `registration_id`, `event_id`, `activity_id`, `user_id`, chave = `registration_id`; consumir `seat.*` e `event.cancelled` (ADR-E2). |
| Relatórios | Já consome `event.*` e `activity.*` sem mudanças. `activity.deleted` (só em rascunho) ainda é ignorado. |
| Notificações | Eventos não conhece os inscritos; avisar participantes sobre `event.updated`/`event.cancelled` (RF08) cabe a Inscrições, que traduz para o tópico `notifications`. |
| Gateway | Rodar `events/scripts/register-gateway-routes.sh` após o primeiro sync. |
| Usuários | Eventos usa `iss`, `sub`, `roles` e o JWKS; não lê o banco de Usuários. |

## Limitações conhecidas
- `processed_messages` não é expurgada (cresce com o volume de mensagens consumidas).
- Sem cache de leitura: no pico de RQ02 a escala é por réplicas (`deploy.replicas`) e índices; as consultas públicas são
  simples e indexadas.
- O layer HTTP (Fastify) e o Kafka não puderam ser executados no ambiente onde o serviço foi escrito (sem acesso ao
  registro npm); foram verificados por checagem de tipos estrita, testes unitários das partes puras e pela suíte de
  integração dos casos de uso contra PostgreSQL real.
