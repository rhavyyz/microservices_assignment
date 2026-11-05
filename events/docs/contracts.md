# Serviço de Eventos — contratos

Contratos públicos do serviço de Eventos: a API HTTP (via Gateway) e as mensagens no Kafka. A fonte executável da API é o
`GET /openapi.json`, gerado dos schemas em `src/http/schemas.ts`. Este documento descreve o mesmo contrato com regras e
exemplos; se os dois divergirem, vale o código. Decisões por trás destes contratos: [`decisions.md`](decisions.md). Os nomes
seguem os contratos de Inscrições (`subscription/CONTRACTS.md`).

Eventos guarda só a **capacidade máxima** de cada atividade; quem conta as vagas ocupadas é Inscrições. Eventos não consome
nenhum tópico.

## 1. Convenções

| Item | Regra |
|---|---|
| URL pública | `{GATEWAY}/events/<caminho>`; o Gateway remove o prefixo `/events`. Os caminhos abaixo estão sem o prefixo e todos começam por `/api/v1` (exceto `/healthcheck` e `/openapi.json`). |
| Formato | JSON, campos em `snake_case`. Datas em ISO 8601 com fuso (`2027-03-10T09:00:00.000Z`); respostas sempre em UTC. |
| Ids | UUID v4 gerados pelo serviço (`event_id`, `activity_id`). Ids de usuário (`organizer_id`) são o `sub` do JWT do serviço de Usuários, repassado pelo Gateway em `X-User-Id`. |
| Dinheiro | `amount_minor`: inteiro em centavos de BRL (`currency` = `BRL`); `0` = gratuita. `paid = amount_minor > 0`. |
| Identidade | Só pelos cabeçalhos do Gateway (seção 1.1). O serviço não recebe nem valida token. |
| Correlação | `X-Trace-Id` do Gateway é reaproveitado se tiver 8–64 caracteres `[A-Za-z0-9._-]`; senão um UUID novo. Sempre devolvido no cabeçalho `X-Trace-Id` da resposta. |
| Campos desconhecidos | Rejeitados com 400 (não são ignorados). Inclui `price_cents` (agora `amount_minor`). |
| Corpo vazio | `publish`, `cancel`, `end` e `DELETE` não têm corpo: não envie `Content-Type: application/json` sem corpo (400). |

### 1.1 Identidade

O Gateway verifica o JWT e envia `X-User-Id` (o `sub`, um UUID) e `X-User-Roles` (papéis separados por vírgula; ausente sem
papéis). Eventos confia nesses cabeçalhos (isolamento de rede, como os outros serviços):

- `X-User-Id` ausente → chamador **anônimo** (serve para as leituras públicas).
- `X-User-Id` presente mas que não é um UUID → **401** `UNAUTHENTICATED`, em qualquer rota de negócio (nunca anônimo).
- `X-User-Roles`: itens separados por vírgula, sem espaços nas pontas, comparados em maiúsculas (`organizer` = `ORGANIZER`).
- Operações que alteram dados, `GET /api/v1/me/events` e `GET /api/v1/activities/{activity_id}/permissions/me` sem identidade
  → 401 `UNAUTHENTICATED` (antes de validar o corpo). `Authorization` é ignorado.

## 2. Recursos

### Event

| Campo | Tipo | Observação |
|---|---|---|
| `event_id` | uuid | |
| `organizer_id` | string | Dono do evento (RN07). |
| `title` | string | 1–200 caracteres, não pode ser só espaços. |
| `organization` | string \| null | Organização responsável, até 200. |
| `description` | string \| null | Até 5000. |
| `location` | string \| null | Até 300. |
| `banner_url` | string (URI) \| null | Até 2000. |
| `starts_at`, `ends_at` | date-time | `ends_at > starts_at`. |
| `status` | `DRAFT` \| `PUBLISHED` \| `CANCELLED` | `DRAFT → PUBLISHED → CANCELLED` ou `DRAFT → CANCELLED`. |
| `created_at`, `updated_at` | date-time | |

### Activity (item da programação)

| Campo | Tipo | Observação |
|---|---|---|
| `activity_id`, `event_id` | uuid | |
| `title` | string | 1–200, não pode ser só espaços. |
| `description` | string \| null | Até 5000. |
| `speaker` | string \| null | Responsável, até 200. |
| `location` | string \| null | Até 300. |
| `starts_at`, `ends_at` | date-time | Dentro do período do evento; `ends_at > starts_at`. |
| `capacity` | integer | 1–100000, capacidade **máxima**. **Imutável** após a criação. Eventos não informa vagas livres nem ocupadas. |
| `amount_minor` | integer | 0–100000000, centavos. Só muda enquanto o evento é `DRAFT`. |
| `currency` | string | Sempre `BRL`. |
| `paid` | boolean | `amount_minor > 0`. |
| `waitlist_enabled` | boolean | Se recusas por lotação podem ir para a lista de espera (tratada por Inscrições). |
| `lifecycle` | `OPEN` \| `ENDED` \| `CANCELLED` | Derivado: `CANCELLED` se o evento está cancelado; senão `ENDED` se `ended_at` existe; senão `OPEN`. |
| `ended_at` | date-time \| null | Quando a atividade foi encerrada (manual ou automaticamente). |
| `registration_open` | boolean | Evento `PUBLISHED`, `lifecycle = OPEN` e `agora < starts_at`. |
| `created_at`, `updated_at` | date-time | |

Uma atividade encerrada ou cancelada continua consultável (`GET` devolve o recurso com o seu `lifecycle`).

### Page

`{"items": [Event], "total": 37, "limit": 20, "offset": 0}` — `total` conta todos os resultados do filtro.

## 3. API HTTP

Legenda de acesso: **público** (sem identidade; com `X-User-Id`, o organizador também vê seus rascunhos) · **identidade**
(qualquer usuário autenticado pelo Gateway) · **organizador** (papel `ORGANIZER`) · **dono** (o `organizer_id` do evento).
Evento ou atividade de outro organizador, ou rascunho de outra pessoa, responde **404**, igual a inexistente.

| Método e caminho | Acesso | Corpo | Sucesso |
|---|---|---|---|
| `GET /api/v1/events` | público | — | 200 Page |
| `GET /api/v1/me/events` | identidade | — | 200 Page |
| `GET /api/v1/events/{event_id}` | público | — | 200 Event + `activities` |
| `GET /api/v1/events/{event_id}/activities` | público | — | 200 `{"items": [Activity]}` |
| `GET /api/v1/activities/{activity_id}` | público | — | 200 Activity |
| `GET /api/v1/activities/{activity_id}/permissions/me` | identidade (interno) | — | 200 `{"can_manage": bool}` |
| `POST /api/v1/events` | organizador | EventCreate | 201 Event |
| `PATCH /api/v1/events/{event_id}` | dono | EventPatch | 200 Event |
| `POST /api/v1/events/{event_id}/publish` | dono | — | 200 Event |
| `POST /api/v1/events/{event_id}/cancel` | dono | — | 200 Event |
| `POST /api/v1/events/{event_id}/activities` | dono | ActivityCreate | 201 Activity |
| `PATCH /api/v1/activities/{activity_id}` | dono | ActivityPatch | 200 Activity |
| `POST /api/v1/activities/{activity_id}/end` | dono | — | 200 Activity |
| `DELETE /api/v1/activities/{activity_id}` | dono | — | 204 |

Internos (não abertos no Gateway): `GET /healthcheck` (200 `{"status":"ok"}` ou 503), `GET /openapi.json` e
`GET /api/v1/activities/{activity_id}/permissions/me`, que Inscrições chama direto pelo discoverer.

### 3.1 Busca — `GET /api/v1/events`, `GET /api/v1/me/events`

| Parâmetro | Tipo | Regra |
|---|---|---|
| `q` | string (até 200) | Texto em título, descrição, organização ou local (sem diferenciar maiúsculas; `%` e `_` são literais). |
| `from` | date-time | Eventos que terminam em `from` ou depois. |
| `to` | date-time | Eventos que começam em `to` ou antes. |
| `limit` | integer 1–100 | Padrão 20. |
| `offset` | integer ≥ 0 | Padrão 0. |

`/events` lista só `PUBLISHED`; `/me/events` lista os eventos do chamador em qualquer status. Ordem: `starts_at`, depois `id`.

```http
GET /events/api/v1/events?q=kafka&from=2027-03-01T00:00:00Z&limit=10
```
```json
{ "items": [ { "event_id": "6f1c…", "organizer_id": "b2e0…", "title": "Semana de Computação", "organization": "UECE",
               "description": null, "location": "Fortaleza", "banner_url": null,
               "starts_at": "2027-03-10T09:00:00.000Z", "ends_at": "2027-03-12T18:00:00.000Z", "status": "PUBLISHED",
               "created_at": "2026-11-02T15:00:00.000Z", "updated_at": "2026-11-02T15:05:00.000Z" } ],
  "total": 1, "limit": 10, "offset": 0 }
```

### 3.2 Criar e editar evento

`EventCreate`: obrigatórios `title`, `starts_at`, `ends_at`; opcionais `organization`, `description`, `location`, `banner_url`.
`EventPatch`: os mesmos campos, todos opcionais, ao menos um; `null` limpa um campo opcional.

```http
POST /events/api/v1/events
X-User-Id: b2e0…            (enviado pelo Gateway)
X-User-Roles: ORGANIZER     (enviado pelo Gateway)
Content-Type: application/json

{"title": "Semana de Computação", "organization": "UECE", "starts_at": "2027-03-10T09:00:00Z", "ends_at": "2027-03-12T18:00:00Z"}
```
→ `201` com o Event em `DRAFT`.

Regras: criar exige o papel `ORGANIZER` (403). Editar não é possível em evento cancelado (409 `EVENT_CANCELLED`). Ao mudar o
período, todas as atividades precisam continuar dentro dele (422 `ACTIVITY_OUTSIDE_EVENT`).

### 3.3 Publicar e cancelar

- `publish`: só de `DRAFT` (409 `INVALID_STATUS`), com ao menos uma atividade (409 `EVENT_WITHOUT_ACTIVITIES`) e com
  `ends_at` no futuro (409 `EVENT_ENDED`). A partir daqui o evento aparece na busca e as atividades abrem inscrições.
- `cancel`: de `DRAFT` ou `PUBLISHED`; é final (409 `EVENT_CANCELLED` se repetido). Na mesma transação publica
  `EventCancelled` e um `ActivityCancelled` por atividade do evento que ainda não tinha encerrado (as encerradas não geram
  mensagem). Inscrições cancela as inscrições ao ler essas mensagens. Depois disso toda atividade do evento mostra
  `lifecycle = CANCELLED` e `registration_open = false`.

### 3.4 Programação

`ActivityCreate`: obrigatórios `title`, `starts_at`, `ends_at`, `capacity`; opcionais `description`, `speaker`, `location`,
`amount_minor` (padrão 0), `waitlist_enabled` (padrão `false`).
`ActivityPatch`: os mesmos campos **exceto `capacity`** (enviá-la dá 400 `VALIDATION_ERROR`), todos opcionais, ao menos um.

```http
POST /events/api/v1/events/6f1c…/activities
Content-Type: application/json

{"title": "Minicurso de Kafka", "speaker": "Ana", "starts_at": "2027-03-10T14:00:00Z", "ends_at": "2027-03-10T17:00:00Z",
 "capacity": 40, "amount_minor": 5000, "waitlist_enabled": true}
```
```json
{ "activity_id": "a91d…", "event_id": "6f1c…", "title": "Minicurso de Kafka", "description": null, "speaker": "Ana", "location": null,
  "starts_at": "2027-03-10T14:00:00.000Z", "ends_at": "2027-03-10T17:00:00.000Z", "capacity": 40,
  "amount_minor": 5000, "currency": "BRL", "paid": true, "waitlist_enabled": true,
  "registration_open": false, "lifecycle": "OPEN", "ended_at": null,
  "created_at": "2026-11-02T15:10:00.000Z", "updated_at": "2026-11-02T15:10:00.000Z" }
```

Regras: atividade dentro do período do evento (422 `ACTIVITY_OUTSIDE_EVENT`); evento cancelado não muda (409
`EVENT_CANCELLED`); mudar `amount_minor` ou apagar a atividade só com o evento em `DRAFT` (409 `EVENT_NOT_DRAFT`).

### 3.5 Encerrar atividade — `POST /api/v1/activities/{activity_id}/end`

Só o dono do evento (outro usuário: 404). Regras, nesta ordem:

1. Evento precisa estar `PUBLISHED` (409 `EVENT_NOT_OPEN`; vale para rascunho e cancelado).
2. Atividade já encerrada → **200 com a atividade atual, sem nova mensagem** (idempotente).
3. `agora < ends_at` → 409 `ACTIVITY_NOT_ENDED`. Inscrições recusa um `ActivityEnded` antecipado e travaria o consumidor,
   então Eventos nunca o emite antes do fim previsto.
4. Caso contrário grava `ended_at = agora`, publica `ActivityEnded` (mesma transação, via outbox) e responde 200 com a
   atividade (`lifecycle = ENDED`).

**Encerramento automático:** um job (a cada 60 s, em cada réplica, seguro com `FOR UPDATE SKIP LOCKED`) encerra, em lotes de
até 100 numa transação cada, as atividades de eventos `PUBLISHED` ainda abertas cujo `ends_at` +
`ACTIVITY_AUTO_END_AFTER_SECONDS` (padrão 86400, um dia) já passou, e publica `ActivityEnded` com `trace_id = null`. O prazo
conta a partir do `ends_at` previsto da atividade.

### 3.6 Permissão — `GET /api/v1/activities/{activity_id}/permissions/me`

Usada por Inscrições (pelo discoverer, não pelo Gateway) antes de cada operação administrativa. Exige identidade (401).
`{"can_manage": true}` se e somente se o chamador é o organizador do evento da atividade; `false` para qualquer outro usuário
que possa ver a atividade. Atividade inexistente, ou rascunho de outra pessoa → 404.

### 3.7 Erros

Corpo `application/problem+json` (mesmo formato do serviço de Usuários):

```json
{ "type": "about:blank", "title": "Bad Request", "status": 400, "detail": "the request is invalid",
  "code": "VALIDATION_ERROR", "traceId": "0f9a6c2e5b7d4e21a3c8b9d0e1f2a3b4",
  "errors": [ { "field": "capacity", "message": "is not allowed" } ] }
```

| Status | `code` | Quando |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Corpo, parâmetros ou query fora do schema; campo desconhecido; id que não é UUID. `errors` lista os campos. |
| 400/413/415 | `BAD_REQUEST` | JSON malformado, corpo grande demais, tipo de conteúdo não suportado. |
| 401 | `UNAUTHENTICATED` | Operação que exige identidade sem `X-User-Id`, ou `X-User-Id` que não é UUID (também nas leituras públicas). |
| 403 | `FORBIDDEN` | Criar evento sem o papel `ORGANIZER`. |
| 404 | `NOT_FOUND` | Inexistente, de outro organizador, rascunho alheio ou rota desconhecida. |
| 409 | `INVALID_STATUS`, `EVENT_CANCELLED`, `EVENT_NOT_DRAFT`, `EVENT_WITHOUT_ACTIVITIES`, `EVENT_ENDED`, `EVENT_NOT_OPEN`, `ACTIVITY_NOT_ENDED` | Transição ou mudança proibida no estado atual. |
| 422 | `INVALID_PERIOD`, `ACTIVITY_OUTSIDE_EVENT` | Período inválido ou atividade fora do evento. |
| 500 | `INTERNAL_ERROR` | Erro inesperado; o detalhe fica só no log, encontrado pelo `traceId`. |

## 4. Mensagens (Kafka)

Eventos só **publica**. Não consome nenhum tópico.

### 4.1 Envelope

Envelope plano, no estilo de Inscrições e Pagamentos: os campos da mensagem ficam no nível de cima, ao lado dos do envelope
(não há `data` aninhado):

```json
{ "message_id": "0b6c…", "schema_version": 1, "type": "ActivityEnded", "occurred_at": "2027-03-10T17:00:00.000Z",
  "trace_id": null, "activity_id": "a91d…", "event_id": "6f1c…", "ends_at": "2027-03-10T17:00:00.000Z" }
```

| Campo | Regra |
|---|---|
| `message_id` | Único por mensagem e **igual em reenvios**: é a chave de deduplicação dos consumidores. |
| `schema_version` | Sempre `1`. |
| `type` | PascalCase, tipos abaixo; tipos desconhecidos são ignorados pelos consumidores. |
| `occurred_at` | Quando a mudança aconteceu (ISO 8601, UTC). |
| `trace_id` | `X-Trace-Id` da requisição HTTP que originou a mudança; `null` no encerramento automático. |

Cabeçalhos Kafka extras nas mensagens publicadas: `message-type` (= `type`) e `trace-id`.

### 4.2 Publicadas em `events.events`

Tópico criado na inicialização, se ausente (`EVENTS_TOPIC`, padrão `events.events`; `EVENTS_TOPIC_PARTITIONS`, padrão 6).
Entrega pelo outbox: *at-least-once*, na ordem em que as mudanças foram confirmadas no banco.

| `type` | Chave | Campos |
|---|---|---|
| `EventCreated`, `EventUpdated`, `EventPublished`, `EventCancelled` | `event_id` | `event_id`, `organizer_id`, `organization`, `name` (= título), `status`, `starts_at`, `ends_at` |
| `ActivityCreated`, `ActivityUpdated`, `ActivityDeleted` | `event_id` | `activity_id`, `event_id`, `name` (= título), `starts_at`, `ends_at`, `capacity`, `amount_minor`, `currency` (`BRL`), `paid`, `waitlist_enabled` |
| `ActivityEnded`, `ActivityCancelled` | `activity_id` | `activity_id`, `event_id`, `ends_at` |

As mensagens de evento e atividade levam o estado completo (não só o que mudou). Não há contagem de vagas. `ActivityDeleted`
só ocorre com o evento em rascunho. As mensagens de evento e de criação/edição/remoção de atividade têm chave = `event_id`
(ordem garantida depois da criação); `ActivityEnded` e `ActivityCancelled` têm chave = `activity_id`.

Quando cada uma é publicada: `ActivityEnded` no encerramento manual (3.5) ou automático, no máximo uma vez por atividade e
nunca antes do `ends_at` previsto; `ActivityCancelled` no cancelamento do evento (3.3), para cada atividade ainda não
encerrada.

> Relatórios ainda lê o formato antigo (`event.created`, `data` aninhado, `version`) e deixa de projetar eventos e atividades
> até ser adaptado; isso é conhecido e aceito.

## 5. Integração com a infraestrutura

| Com | Contrato |
|---|---|
| Service-discoverer | Registra `{"kind":"events","host":"<SERVICE_HOST>"}` em `POST /register` (via a biblioteca TypeScript compartilhada `discovery`) uma única vez ao iniciar, com as tentativas padrão da biblioteca; `GET /healthcheck` responde 200 só com o banco migrado e acessível. Inscrições resolve `events` pelo discoverer. |
| Gateway | Lê `GET /openapi.json`. As rotas da seção 3 (menos `permissions/me`) são abertas por `events/scripts/register-gateway-routes.sh`: leituras públicas com `requireAuth=false` e `rateLimitBy=ip`; escritas, `/me/events` e `end` com `requireAuth=true` e `rateLimitBy=user_or_ip`. O Gateway verifica o JWT e injeta `X-User-Id` / `X-User-Roles`. |
| Serviço de Usuários | Nenhuma chamada: Eventos não valida JWT nem baixa chaves. |
| Inscrições | Lê `GET /api/v1/activities/{activity_id}` e `.../permissions/me`; consome `events.events` (`EventCancelled`, `Activity*`). |
