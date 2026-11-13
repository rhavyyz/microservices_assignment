# Contratos entre os serviços

Este documento descreve **o que cada serviço oferece e consome** (REST e Kafka) e **como os serviços se relacionam**.
É um índice de contratos: o detalhe campo a campo fica no documento de cada serviço, que é a fonte de verdade
(seção 9). Se este texto divergir do código, vale o código.

## 1. Mapa de relações

```text
                         ┌────────────┐   JWKS (GET /.well-known/jwks.json)
  Frontend ── HTTP ────► │  Gateway   │ ◄───────────────────────────────┐
  (React)   /{kind}/...  │ :8080      │                                 │
       ▲                 └─────┬──────┘                          ┌──────┴─────┐
       │ WebSocket /ws         │ HTTP (kind via discoverer)      │  Usuários  │
       │                       ▼                                 └──────▲─────┘
       │        Usuários · Eventos · Inscrições · Pagamentos ·          │ GET /internal/users/{id}
       │        Relatórios · Certificados · Notificações                │
       │                                                                │
       │   REST entre serviços (via discoverer)                         │
       │     Inscrições ──► Eventos      (atividade, permissão)         │
       │     Pagamentos ──► Inscrições   (fatos da inscrição)           │
       │     Certificados ─► Eventos, Usuários ─────────────────────────┘
       │
       │   Kafka (cada serviço publica só os próprios eventos de domínio)
       │     Eventos     ──► events.events        ──► Inscrições, Relatórios
       │     Inscrições  ──► subscription.events  ──► Pagamentos, Certificados, Relatórios
       │     Pagamentos  ──► payments.events      ──► Inscrições, Relatórios
       │     Inscrições, Pagamentos ──► notifications ──► Notificações
       └──── Notificações ──► notifications-push ──► Gateway
```

Regras gerais de relacionamento:

- **Declarativo e reativo.** Nenhum serviço envia comandos a outro por Kafka. Cada um publica fatos sobre o que é seu
  e reage aos fatos dos outros (ADR-002).
- **REST só para consulta imediata**, sempre pelo service-discoverer (kind → host saudável). Nunca por endereço fixo.
- **Cada serviço é dono do seu banco.** Nenhum lê o banco de outro; quem precisa de dados alheios consome eventos
  (Relatórios) ou consulta a API (Certificados).
- **Entrada única:** o Gateway é o único acesso externo. Endpoints `/internal/...` e `permissions/me` não são
  abertos nele; são protegidos por isolamento de rede.

## 2. Convenções comuns

| Item | Contrato |
|---|---|
| URL pública | `{GATEWAY}/{kind}/<caminho do serviço>`; o Gateway remove o prefixo `/{kind}`. Kinds: `user`, `events`, `subscription`, `payments`, `reports`, `certificates`, `notifications`. |
| Identidade | O Gateway verifica o JWT (RS256, `iss=eventhub-users`, chave do JWKS de Usuários) e envia **`X-User-Id`** (`sub`, UUID) e **`X-User-Roles`** (papéis separados por vírgula; ausente sem papéis). Os serviços confiam só nesses cabeçalhos; qualquer valor vindo do cliente é apagado pelo Gateway. Usuários é a exceção: emite e valida o próprio JWT. |
| Correlação | **`X-Trace-Id`** (`^[A-Za-z0-9._-]{8,64}$`): o Gateway mantém o valor válido ou gera um UUID; os serviços o ecoam na resposta, usam no log, devolvem em `traceId` nos erros e gravam em `trace_id` nos eventos Kafka (nulo em trabalho de fundo). `X-Request-Id` e `X-Correlation-Id` são ignorados. |
| Erros | `application/problem+json` com `{title, status, code, detail?, traceId}` (Eventos acrescenta `errors[]` em validação). O `code` é estável e é o que o cliente deve testar. |
| Dinheiro | `amount_minor`: inteiro em centavos; `currency` = `BRL`. `0` = gratuita. |
| Datas | ISO 8601 com fuso. |
| Ids | UUID. |
| Saúde | `GET /healthcheck` em todo serviço (200 quando o próprio banco responde; Kafka fora do ar **não** derruba a saúde). O discoverer remove hosts sem 2xx após cerca de 1 minuto. |
| OpenAPI | `GET /openapi.json` em cada serviço; o Gateway o lê para descobrir rotas e configurações (`x-gateway`). |

## 3. Service-discoverer

| Operação | Contrato |
|---|---|
| `POST /register` | `{"kind": "<kind>", "host": "<host:porta>"}`. Registro em memória; os serviços re-registram periodicamente pela biblioteca `discovery` (Python, TypeScript, Go, Java). |
| `GET /consult?kind=<kind>` | Devolve `{"host": "..."}` de uma instância saudável do kind (400 kind desconhecido, 503 sem instância). A biblioteca guarda em cache e consulta de novo se o host falhar. |
| `GET /healthcheck` | Saúde do próprio discoverer. |

Quem o usa: Gateway (roteamento), Inscrições → Eventos, Pagamentos → Inscrições, Certificados → Eventos e Usuários.

## 4. Gateway

| Contrato | Detalhe |
|---|---|
| Roteamento | `/{kind}/resto` → instância saudável do kind. Endpoints novos nascem **privados** (404); a configuração (`isPublic`, `requireAuth`, `maxPerMin`, `rateLimitBy`) vem do `x-gateway` do `openapi.json` (somente inserção) ou de `PUT /admin/endpoints`. |
| `requireAuth=true` | Sem token ou token inválido → 401; sem chave do JWKS disponível → 503. Com `requireAuth=false`, token ausente ou inválido segue como anônimo, sem `X-User-Id`. |
| CORS e rate limit | Aplicados no Gateway (preflight, cabeçalhos, limite por endpoint por IP ou por usuário). Os serviços não configuram CORS. |
| `GET /ws` | WebSocket com `Authorization: Bearer` ou `?access_token=`; recebe as notificações do usuário empurradas por `notifications-push`. |
| `GET/PUT /admin/endpoints` | Administração das rotas. **Sem autenticação** (limitação conhecida; não expor a porta). |
| Kafka | Consome `notifications-push` (item 7). |

## 5. Contratos REST por serviço

Todos os caminhos abaixo são os do serviço (sem o prefixo `/{kind}`). “Pública” = aberta no Gateway; “interna” =
só entre serviços.

### 5.1 Usuários (`user`) — detalhe em `docs/api/users.openapi.yaml`

| Operação | Acesso | Resultado |
|---|---|---|
| `POST /api/v1/auth/register` | pública | cria conta `PARTICIPANT`; `requestedRole: ORGANIZER` só abre um pedido (`organizerRequest: PENDING`) |
| `POST /api/v1/auth/login` | pública | JWT RS256 |
| `GET /api/v1/users/me` · `PATCH /api/v1/users/me` | autenticada | consulta e atualização do perfil próprio |
| `GET /api/v1/users` | `ORGANIZER` | busca por `id`, `email`, `name` (paginada) |
| `GET /api/v1/admin/users` | `ADMIN` | lista com filtro `q` e `organizerRequest` |
| `PUT /api/v1/admin/users/{id}/organizer` | `ADMIN` | corpo `{"approved": bool}` aprova ou recusa o pedido |
| `GET /.well-known/jwks.json` | pública | chaves públicas; consumida pelo Gateway |
| `GET /internal/users/{id}` | interna | `{"id","name"}` e nada mais; consumida por Certificados |

Os papéis do token são `PARTICIPANT`, `ORGANIZER` e `ADMIN`. Usuários não consome nem publica Kafka.

### 5.2 Eventos (`events`) — detalhe em `events/docs/contracts.md`

| Operação | Acesso | Resultado |
|---|---|---|
| `GET /api/v1/events` · `GET /api/v1/events/{event_id}` | pública | busca paginada (`q`, `from`, `to`, `limit`, `offset`) e detalhe com atividades |
| `GET /api/v1/events/{event_id}/activities` · `GET /api/v1/activities/{activity_id}` | pública | programação e atividade |
| `GET /api/v1/me/events` | autenticada | eventos do chamador em qualquer status |
| `POST /api/v1/events` | `ORGANIZER` | cria evento em `DRAFT` |
| `PATCH /api/v1/events/{event_id}` · `POST .../publish` · `POST .../cancel` | dono | edita, publica, cancela |
| `POST /api/v1/events/{event_id}/activities` | dono | cria atividade (`capacity` imutável) |
| `PATCH /api/v1/activities/{activity_id}` · `POST .../end` · `DELETE ...` | dono | edita, encerra, remove (só em `DRAFT`) |
| `GET /api/v1/activities/{activity_id}/permissions/me` | interna | `{"can_manage": bool}`; consumida por Inscrições |

Eventos guarda só a capacidade máxima; quem conta as vagas é Inscrições. Erros de negócio: 403 `FORBIDDEN`, 404
`NOT_FOUND` (também para recurso de outro organizador), 409 (`EVENT_CANCELLED`, `EVENT_NOT_DRAFT`, `INVALID_STATUS`,
`ACTIVITY_ENDED`, ...), 422 (`ACTIVITY_OUTSIDE_EVENT`, `INVALID_PERIOD`).

### 5.3 Inscrições (`subscription`) — detalhe em `subscription/CONTRACTS.md`

| Operação | Acesso | Resultado |
|---|---|---|
| `POST /api/v1/activities/{activity_id}/registrations` | autenticada | cria a inscrição: `CONFIRMED` (gratuita), `PENDING_PAYMENT` (paga, com vaga) ou `WAITLISTED` |
| `GET /api/v1/activities/{activity_id}/availability` | autenticada | disponibilidade de vagas da atividade |
| `GET /api/v1/registrations/me` · `GET /api/v1/registrations/{registration_id}` | dono | consulta |
| `POST /api/v1/registrations/{registration_id}/cancel` | dono | cancela e libera a vaga |
| `POST /api/v1/registrations/{registration_id}/accept-offer` | dono | aceita a oferta da fila (`OFFERED`) |
| `GET /api/v1/activities/{activity_id}/registrations` | organizador da atividade | lista de inscritos |
| `POST /api/v1/registrations/{registration_id}/check-in` | organizador da atividade | registra presença |
| `GET /internal/registrations/{registration_id}` | interna | fatos da inscrição para Pagamentos (abaixo) |

`GET /internal/registrations/{registration_id}` devolve `registration_id`, `activity_id`, `user_id`, `status`,
`amount_minor`, `currency`, `expires_at` (nulo fora de `OFFERED`/`PENDING_PAYMENT`) e `event_id`; id desconhecido ou
inválido → 404 `REGISTRATION_NOT_FOUND`. Estados da inscrição: `WAITLISTED`, `OFFERED`, `PENDING_PAYMENT`,
`CONFIRMED`, `CANCELLED`, `EXPIRED`, `REJECTED`. A reserva dura `RESERVATION_SECONDS` (900).

### 5.4 Pagamentos (`payments`) — detalhe em `payments/README.md`

| Operação | Acesso | Resultado |
|---|---|---|
| `POST /payments` | dono da inscrição | corpo `{"registration_id"}`; cria o pagamento `PENDING` (201; 200 se já existir) com valor, moeda, dono e atividade lidos de Inscrições |
| `GET /payments/{paymentId}` · `GET /payments?registration_id=` | dono | consulta |
| `POST /payments/{paymentId}/simulate` | dono | simulador do provedor: `{"action":"approve"\|"decline"\|"expire"}` (`SIMULATOR_ENABLED`) |

Estados: `PENDING → APPROVED \| DECLINED \| EXPIRED \| CANCELLED`; `APPROVED → REFUNDED`. Erros: 404
`REGISTRATION_NOT_FOUND`, 409 `REGISTRATION_NOT_PAYABLE`, 409 `PAYMENT_NOT_APPLIED` (com `payment_status`), 503
`UPSTREAM_UNAVAILABLE` (Inscrições inacessível). O prazo do pagamento é próprio (`PAYMENT_TTL_SECONDS`, 900).

### 5.5 Relatórios (`reports`) — detalhe em `reports/README.md`

Somente leitura, só para o organizador dono do evento (outro usuário → 404, igual a inexistente).

| Operação | Resultado |
|---|---|
| `GET /events` | eventos do chamador (paginado: `limit` 1–100, `offset`) |
| `GET /events/{eventId}/summary` | inscrições, pagamentos, ocupação, presença e atividades por ciclo de vida |
| `GET /events/{eventId}/activities` | indicadores por atividade (paginado) |
| `GET /events/{eventId}/registrations` | contagem por status |

### 5.6 Certificados (`certificates`) — detalhe em `certificates/README.md`

| Operação | Acesso | Resultado |
|---|---|---|
| `GET /api/v1/certificates/me?limit=&offset=` | dono | `{"certificates":[{id, registration_id, activity_id, event_id, issued_at}]}` |
| `GET /api/v1/certificates/{certificate_id}` | dono | PDF; de outro usuário → 404 `NOT_FOUND` |

Não existe endpoint de criação: certificado só nasce de `AttendanceEligible` (item 6).
Consome por REST: `GET /api/v1/events/{event_id}` (Eventos) e `GET /internal/users/{id}` (Usuários).

### 5.7 Notificações (`notifications`) — detalhe no `README.md` raiz

| Operação | Resultado |
|---|---|
| `GET /list` | notificações do usuário, mais novas primeiro, paginação por `base_notification_id`; filtros `status` e `limit` |
| `PUT /update-state` | corpo `[{"id","status"}]` (1 a 100); `status` ∈ `DEFAULT`, `RECEIVED`, `SEEN`; aplicação parcial com `{"updated","errors"}` |

## 6. Contratos Kafka

### 6.1 Envelope e regras comuns

Mensagem JSON **plana** (sem `data` aninhado):

| Campo | Regra |
|---|---|
| `message_id` | UUID único por mensagem e **igual em reenvios**; é a chave de deduplicação dos consumidores. |
| `schema_version` | Sempre `1`. Outro valor é inválido e vai para a DLQ. |
| `type` | PascalCase (tabelas abaixo). |
| `occurred_at` | ISO 8601. |
| `trace_id` | `X-Trace-Id` de origem; pode ser nulo. |

Regras de compatibilidade:

1. Entrega **at-least-once** (Transactional Outbox no produtor); todo consumidor deduplica por `message_id`, na mesma
   transação do efeito.
2. Consumidor **ignora campos desconhecidos** e **tipos desconhecidos** (confirma sem erro). Acrescentar campo é
   mudança compatível; remover, renomear ou mudar o tipo de um campo exige nova `schema_version`.
3. Mensagem inválida (JSON, `schema_version`, campos obrigatórios) vai para a DLQ do consumidor com referência
   (tópico, partição, offset), nunca bloqueando a partição.
4. A chave Kafka mantém a ordem do agregado; consumidores usam `aggregate_version` (Inscrições) para rejeitar estado antigo.
5. Cada serviço consumidor usa grupo próprio e cria, se ausentes, os tópicos de que depende.

### 6.2 Tópicos

| Tópico | Produtor | Consumidores | Chave | DLQ |
|---|---|---|---|---|
| `events.events` | Eventos | Inscrições, Relatórios | `event_id` (eventos e criação/edição/remoção de atividade); `activity_id` (`ActivityEnded`, `ActivityCancelled`) | `subscription.dlq`, `reports.dlq` |
| `subscription.events` | Inscrições | Pagamentos, Certificados, Relatórios | `registration_id` | `certificates.dlq`, `reports.dlq` |
| `payments.events` | Pagamentos | Inscrições, Relatórios | `registration_id` | `subscription.dlq`, `reports.dlq` |
| `notifications` | Inscrições, Pagamentos | Notificações | `user_id` | — (inválidas são registradas e ignoradas) |
| `notifications-push` | Notificações | Gateway | — | — |

### 6.3 Tipos por tópico

**`events.events`** (Eventos):

| `type` | Campos além do envelope |
|---|---|
| `EventCreated`, `EventUpdated`, `EventPublished`, `EventCancelled` | `event_id`, `organizer_id`, `organization`, `name`, `status`, `starts_at`, `ends_at` |
| `ActivityCreated`, `ActivityUpdated`, `ActivityDeleted` | `activity_id`, `event_id`, `name`, `starts_at`, `ends_at`, `capacity`, `amount_minor`, `currency`, `paid`, `waitlist_enabled` |
| `ActivityEnded`, `ActivityCancelled` | `activity_id`, `event_id`, `ends_at` |

Inscrições reage só a `ActivityEnded` e `ActivityCancelled` (cancelamento é terminal e cancela as inscrições da
atividade); Relatórios projeta todos.

**`subscription.events`** (Inscrições), com `registration_id`, `activity_id`, `user_id`, `event_id`, `aggregate_version`, `status`:

| `type` | Quando | Quem reage |
|---|---|---|
| `RegistrationWaitlisted`, `WaitlistOffered` | entrou na fila; recebeu oferta | Relatórios |
| `RegistrationPendingPayment` | inscrição paga com vaga ou oferta paga aceita | Relatórios (Pagamentos ignora; a cobrança nasce em `POST /payments`) |
| `RegistrationConfirmed`, `RegistrationRejected` | confirmação; recusa | Relatórios |
| `RegistrationCancelled`, `RegistrationExpired` | cancelamento; reserva vencida | **Pagamentos** (cancela cobrança pendente ou estorna a aprovada), Relatórios |
| `AttendanceRecorded` | check-in | Relatórios |
| `AttendanceEligible` | presença ≥ `ATTENDANCE_MIN_PERCENT` (75) no evento; no máximo uma vez por pessoa e evento; campos extras `attended_activities`, `total_activities`, `attendance_percentage` | **Certificados**, Relatórios |

**`payments.events`** (Pagamentos), com `registration_id`, `amount_minor`, `currency`, `payment_id`, `user_id`, `event_id`, `activity_id`, `status`, `reason`:

| `type` | Efeito em Inscrições |
|---|---|
| `PaymentApproved` | se a inscrição está `PENDING_PAYMENT`, dentro da reserva e com o mesmo valor/moeda → `CONFIRMED`; caso contrário é ignorada (e Pagamentos estorna) |
| `PaymentDeclined` | `PENDING_PAYMENT` → `REJECTED`; libera a vaga e promove a fila |
| `PaymentCreated`, `PaymentExpired`, `PaymentCancelled`, `PaymentRefunded` | informativos (sem mudança de estado) |

**`notifications`** (Inscrições, Pagamentos) — formato de Notificações:

| Campo | Regra |
|---|---|
| `user_id`, `message` | obrigatórios, não vazios |
| `payload` + `payload_type` | objeto JSON e texto; ambos presentes ou ambos ausentes |
| `redirect_url` | opcional, opaco |
| `id`, `status`, `seen` | nunca enviados pelo produtor |

**`notifications-push`** (Notificações → Gateway): `{id, user_id, message, redirect_url, payload, payload_type, status, created_at}`.
Melhor esforço; pode repetir, então o receptor deduplica por `id`; falha no push é recuperada por `GET /list`.

## 7. Quem chama quem por REST

| Origem | Destino | Chamada | Para quê |
|---|---|---|---|
| Gateway | Usuários | `GET /.well-known/jwks.json` | verificar o JWT |
| Gateway | todos | `/{kind}/...` | roteamento (via discoverer) |
| Inscrições | Eventos | `GET /api/v1/activities/{activity_id}` | capacidade, preço, abertura, datas |
| Inscrições | Eventos | `GET /api/v1/activities/{activity_id}/permissions/me` | autorizar operação do organizador |
| Pagamentos | Inscrições | `GET /internal/registrations/{registration_id}` | valor, moeda, dono, status e prazo da inscrição |
| Certificados | Eventos | `GET /api/v1/events/{event_id}` | título, período e status do evento |
| Certificados | Usuários | `GET /internal/users/{id}` | nome do participante |

Chamadas em nome do usuário levam `X-User-Id`, `X-User-Roles` (se houver) e `X-Trace-Id`; chamadas de fundo não
carregam identidade. Timeout de 5 s, sem retry de mutações. Falha do destino nunca corrompe estado: Pagamentos
responde 503 `UPSTREAM_UNAVAILABLE`; Certificados guarda a mensagem e tenta de novo.

## 8. Fluxo de inscrição paga em termos de contrato

1. Participante: `POST /subscription/api/v1/activities/{id}/registrations`. Inscrições chama Eventos (REST),
   reserva a vaga, grava a inscrição `PENDING_PAYMENT` e publica `RegistrationPendingPayment`.
2. Participante: `POST /payments/payments` com `{"registration_id"}`. Pagamentos chama Inscrições
   (`GET /internal/registrations/{id}`) e cria o pagamento `PENDING`; publica `PaymentCreated`.
3. Provedor (simulador): `POST /payments/payments/{id}/simulate`. Pagamentos publica `PaymentApproved`,
   `PaymentDeclined` ou `PaymentExpired`, e uma notificação ao usuário.
4. Inscrições consome `payments.events`: `PaymentApproved` → `CONFIRMED` + `RegistrationConfirmed`;
   `PaymentDeclined` → `REJECTED` + `RegistrationRejected`.
5. Se a inscrição for cancelada ou a reserva vencer, Inscrições publica `RegistrationCancelled`/`RegistrationExpired`;
   Pagamentos cancela a cobrança pendente ou estorna a aprovada (`PaymentCancelled`/`PaymentRefunded`).
   Aprovação que chega depois do prazo não é honrada.
6. Relatórios e Notificações apenas observam os mesmos eventos; Certificados reage a `AttendanceEligible` depois dos
   check-ins.

## 9. Fonte de verdade por serviço

| Serviço | Documento |
|---|---|
| Usuários | `docs/api/users.openapi.yaml`, `docs/architecture/users-service.md` |
| Eventos | `events/docs/contracts.md` |
| Inscrições | `subscription/CONTRACTS.md` |
| Pagamentos | `payments/README.md` |
| Relatórios | `reports/README.md` |
| Certificados | `certificates/README.md` |
| Notificações e Gateway | `README.md` (raiz) |
| Decisões por trás dos contratos | `docs/architecture/technical-decisions.md` (ADR-002 e DT-*) |
