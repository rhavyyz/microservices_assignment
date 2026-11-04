# Serviço de Eventos — contratos

Contratos públicos do serviço de Eventos: a API HTTP (via Gateway) e as mensagens no Kafka. A fonte executável da API é o
`GET /openapi.json`, gerado dos schemas em `src/http/schemas.ts`. Este documento descreve o mesmo contrato com regras e
exemplos; se os dois divergirem, vale o código. Decisões por trás destes contratos: [`decisions.md`](decisions.md).

## 1. Convenções

| Item | Regra |
|---|---|
| URL pública | `{GATEWAY}/events/<caminho>`; o Gateway remove o prefixo `/events`. Os caminhos abaixo estão sem o prefixo. |
| Formato | JSON, campos em `snake_case`. Datas em ISO 8601 com fuso (`2027-03-10T09:00:00.000Z`); respostas sempre em UTC. |
| Ids | UUID v4 gerados pelo serviço. Ids de usuário (`organizer_id`, `user_id`) são o `sub` do token do serviço de Usuários. |
| Dinheiro | `price_cents`: inteiro em centavos de BRL; `0` = gratuita. `paid = price_cents > 0`. |
| Autenticação | `Authorization: Bearer <access token>` (JWT RS256 do serviço de Usuários), validado pelo próprio serviço porque ele precisa de `roles`. `X-User-Id` é ignorado, inclusive quando o Gateway passar a injetá-lo (P3): o Gateway precisa continuar repassando `Authorization`. |
| Correlação | `X-Request-Id` do Gateway é reaproveitado se tiver 8–64 caracteres `[A-Za-z0-9._-]`; senão um UUID novo. Sempre devolvido no cabeçalho `X-Request-Id` da resposta. |
| Campos desconhecidos | Rejeitados com 400 (não são ignorados). |
| Corpo vazio | `publish`, `cancel` e `DELETE` não têm corpo: não envie `Content-Type: application/json` sem corpo (400). |

## 2. Recursos

### Event

| Campo | Tipo | Observação |
|---|---|---|
| `id` | uuid | |
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
| `id`, `event_id` | uuid | |
| `title` | string | 1–200, não pode ser só espaços. |
| `description` | string \| null | Até 5000. |
| `speaker` | string \| null | Responsável, até 200. |
| `location` | string \| null | Até 300. |
| `starts_at`, `ends_at` | date-time | Dentro do período do evento; `ends_at > starts_at`. |
| `capacity` | integer | 1–100000. **Imutável** após a criação. |
| `available` | integer | Vagas livres = `capacity` − vagas ocupadas por inscrições (pendentes ou confirmadas). |
| `price_cents` | integer | 0–100000000. Só muda enquanto o evento é `DRAFT`. |
| `paid` | boolean | `price_cents > 0`. |
| `waitlist_enabled` | boolean | Se recusas por lotação podem ir para a lista de espera (tratada por Inscrições). |
| `created_at`, `updated_at` | date-time | |

### Page

`{"items": [Event], "total": 37, "limit": 20, "offset": 0}` — `total` conta todos os resultados do filtro.

## 3. API HTTP

Legenda de acesso: **público** (sem token; com token, o organizador também vê seus rascunhos) · **token** (qualquer usuário
autenticado) · **organizador** (papel `ORGANIZER`) · **dono** (o `organizer_id` do evento). Evento ou atividade de outro
organizador, ou rascunho de outra pessoa, responde **404**, igual a inexistente.

| Método e caminho | Acesso | Corpo | Sucesso |
|---|---|---|---|
| `GET /events` | público | — | 200 Page |
| `GET /me/events` | token | — | 200 Page |
| `GET /events/{eventId}` | público | — | 200 Event + `activities` |
| `GET /events/{eventId}/activities` | público | — | 200 `{"items": [Activity]}` |
| `GET /activities/{activityId}` | público | — | 200 Activity |
| `POST /events` | organizador | EventCreate | 201 Event |
| `PATCH /events/{eventId}` | dono | EventPatch | 200 Event |
| `POST /events/{eventId}/publish` | dono | — | 200 Event |
| `POST /events/{eventId}/cancel` | dono | — | 200 Event |
| `POST /events/{eventId}/activities` | dono | ActivityCreate | 201 Activity |
| `PATCH /activities/{activityId}` | dono | ActivityPatch | 200 Activity |
| `DELETE /activities/{activityId}` | dono | — | 204 |

Internos (não abertos no Gateway): `GET /healthcheck` (200 `{"status":"ok"}` ou 503) e `GET /openapi.json`.

### 3.1 Busca — `GET /events`, `GET /me/events`

| Parâmetro | Tipo | Regra |
|---|---|---|
| `q` | string (até 200) | Texto em título, descrição, organização ou local (sem diferenciar maiúsculas; `%` e `_` são literais). |
| `from` | date-time | Eventos que terminam em `from` ou depois. |
| `to` | date-time | Eventos que começam em `to` ou antes. |
| `limit` | integer 1–100 | Padrão 20. |
| `offset` | integer ≥ 0 | Padrão 0. |

`/events` lista só `PUBLISHED`; `/me/events` lista os eventos do chamador em qualquer status. Ordem: `starts_at`, depois `id`.

```http
GET /events/events?q=kafka&from=2027-03-01T00:00:00Z&limit=10
```
```json
{ "items": [ { "id": "6f1c…", "organizer_id": "b2e0…", "title": "Semana de Computação", "organization": "UECE",
               "description": null, "location": "Fortaleza", "banner_url": null,
               "starts_at": "2027-03-10T09:00:00.000Z", "ends_at": "2027-03-12T18:00:00.000Z", "status": "PUBLISHED",
               "created_at": "2026-11-02T15:00:00.000Z", "updated_at": "2026-11-02T15:05:00.000Z" } ],
  "total": 1, "limit": 10, "offset": 0 }
```

### 3.2 Criar e editar evento

`EventCreate`: obrigatórios `title`, `starts_at`, `ends_at`; opcionais `organization`, `description`, `location`, `banner_url`.
`EventPatch`: os mesmos campos, todos opcionais, ao menos um; `null` limpa um campo opcional.

```http
POST /events/events
Authorization: Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6…
Content-Type: application/json

{"title": "Semana de Computação", "organization": "UECE", "starts_at": "2027-03-10T09:00:00Z", "ends_at": "2027-03-12T18:00:00Z"}
```
→ `201` com o Event em `DRAFT`.

Regras: criar exige o papel `ORGANIZER` (403). Editar não é possível em evento cancelado (409 `EVENT_CANCELLED`). Ao mudar o
período, todas as atividades precisam continuar dentro dele (422 `ACTIVITY_OUTSIDE_EVENT`).

### 3.3 Publicar e cancelar

- `publish`: só de `DRAFT` (409 `INVALID_STATUS`), com ao menos uma atividade (409 `EVENT_WITHOUT_ACTIVITIES`) e com
  `ends_at` no futuro (409 `EVENT_ENDED`). A partir daqui o evento aparece na busca e aceita reservas.
- `cancel`: de `DRAFT` ou `PUBLISHED`; é final (409 `EVENT_CANCELLED` se repetido). Inscrições cancela as inscrições ao ler
  `event.cancelled`.

### 3.4 Programação

`ActivityCreate`: obrigatórios `title`, `starts_at`, `ends_at`, `capacity`; opcionais `description`, `speaker`, `location`,
`price_cents` (padrão 0), `waitlist_enabled` (padrão `false`).
`ActivityPatch`: os mesmos campos **exceto `capacity`** (enviá-la dá 400 `VALIDATION_ERROR`), todos opcionais, ao menos um.

```http
POST /events/events/6f1c…/activities
Authorization: Bearer eyJ…
Content-Type: application/json

{"title": "Minicurso de Kafka", "speaker": "Ana", "starts_at": "2027-03-10T14:00:00Z", "ends_at": "2027-03-10T17:00:00Z",
 "capacity": 40, "price_cents": 5000, "waitlist_enabled": true}
```
```json
{ "id": "a91d…", "event_id": "6f1c…", "title": "Minicurso de Kafka", "description": null, "speaker": "Ana", "location": null,
  "starts_at": "2027-03-10T14:00:00.000Z", "ends_at": "2027-03-10T17:00:00.000Z", "capacity": 40, "available": 40,
  "price_cents": 5000, "paid": true, "waitlist_enabled": true,
  "created_at": "2026-11-02T15:10:00.000Z", "updated_at": "2026-11-02T15:10:00.000Z" }
```

Regras: atividade dentro do período do evento (422 `ACTIVITY_OUTSIDE_EVENT`); evento cancelado não muda (409
`EVENT_CANCELLED`); mudar `price_cents` ou apagar a atividade só com o evento em `DRAFT` (409 `EVENT_NOT_DRAFT`).

### 3.5 Erros

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
| 401 | `UNAUTHENTICATED` | Sem token numa operação protegida, token inválido, expirado, de outro emissor ou cabeçalho malformado. Um token inválido também dá 401 nas leituras públicas. |
| 403 | `FORBIDDEN` | Criar evento sem o papel `ORGANIZER`. |
| 404 | `NOT_FOUND` | Inexistente, de outro organizador, rascunho alheio ou rota desconhecida. |
| 409 | `INVALID_STATUS`, `EVENT_CANCELLED`, `EVENT_NOT_DRAFT`, `EVENT_WITHOUT_ACTIVITIES`, `EVENT_ENDED` | Transição ou mudança proibida no estado atual. |
| 422 | `INVALID_PERIOD`, `ACTIVITY_OUTSIDE_EVENT` | Período inválido ou atividade fora do evento. |
| 503 | `AUTH_UNAVAILABLE` | Nenhuma chave de token em cache e o serviço de Usuários inacessível. |
| 500 | `INTERNAL_ERROR` | Erro inesperado; o detalhe fica só no log, encontrado pelo `traceId`. |

## 4. Mensagens (Kafka)

### 4.1 Envelope

Todas as mensagens, produzidas ou consumidas, usam o envelope comum do barramento (o mesmo do serviço de Relatórios):

```json
{ "message_id": "0b6c…", "type": "seat.reserved", "version": 1, "occurred_at": "2027-03-01T12:00:00.000Z",
  "correlation_id": "0f9a6c2e5b7d4e21a3c8b9d0e1f2a3b4", "data": { … } }
```

| Campo | Regra |
|---|---|
| `message_id` | Único por mensagem e **igual em reenvios**: é a chave de deduplicação dos consumidores. |
| `type` | Tipos abaixo; tipos desconhecidos são ignorados pelos consumidores. |
| `version` | Sempre `1`. |
| `occurred_at` | Quando a mudança aconteceu (ISO 8601, UTC). |
| `correlation_id` | `X-Request-Id` da requisição HTTP que originou a mudança, ou o `correlation_id` da mensagem consumida. Pode ser `null`. |

Cabeçalhos Kafka extras nas mensagens publicadas: `message-type` (= `type`) e `correlation-id`.

### 4.2 Publicadas em `events-events`

Entrega pelo outbox: *at-least-once*, na ordem em que as mudanças foram confirmadas no banco.

| `type` | Chave | `data` |
|---|---|---|
| `event.created`, `event.updated`, `event.published`, `event.cancelled` | `event_id` | `event_id`, `organizer_id`, `organization`, `name` (= título), `status`, `starts_at`, `ends_at` |
| `activity.created`, `activity.updated`, `activity.deleted` | `event_id` | `activity_id`, `event_id`, `name` (= título), `starts_at`, `ends_at`, `capacity`, `available`, `price_cents`, `currency` (`BRL`), `paid`, `waitlist_enabled` |
| `seat.reserved` | `registration_id` | `registration_id`, `event_id`, `activity_id`, `user_id`, `price_cents`, `currency`, `paid`, `available` |
| `seat.rejected` | `registration_id` | `registration_id`, `event_id`, `activity_id`, `user_id`, `reason`, `waitlist_enabled` |
| `seat.released` | `registration_id` | `registration_id`, `event_id`, `activity_id`, `user_id`, `available`, `waitlist_enabled` |

Valores de `reason` em `seat.rejected`:

| `reason` | Quando |
|---|---|
| `FULL` | Atividade lotada no momento do pedido. |
| `ACTIVITY_NOT_FOUND` | Atividade inexistente, de outro evento, ou id que não é UUID. |
| `EVENT_NOT_OPEN` | Evento em rascunho ou cancelado. |
| `REGISTRATION_CLOSED` | A atividade já começou. |

As mensagens de evento e atividade levam o estado completo (não só o que mudou), para que projeções como a de Relatórios
se mantenham sem consultar este serviço. `activity.deleted` só ocorre com o evento em rascunho, quando nenhuma vaga existe.

### 4.3 Consumidas de `subscription-events` (grupo `events-service`)

Produzidas pelo serviço de Inscrições, com chave = `registration_id`.

| `type` | `data` obrigatório | Efeito | Resposta |
|---|---|---|---|
| `registration.requested` | `registration_id`, `event_id`, `activity_id` (+ `user_id` opcional) | Ocupa uma vaga se houver | `seat.reserved` ou `seat.rejected` |
| `registration.cancelled` | idem | Libera a vaga, se a inscrição tinha uma | `seat.released` (nada se não tinha vaga) |
| `registration.expired` | idem | idem | idem |

Garantias:
- O mesmo `message_id` é aplicado uma única vez (reentregas são ignoradas).
- Um novo `registration.requested` para uma inscrição que já tem vaga responde `seat.reserved` de novo, sem ocupar outra.
- Mensagens da mesma inscrição são aplicadas uma de cada vez, mesmo que cheguem por partições diferentes.
- Nunca há mais vagas ocupadas que a capacidade, sob qualquer concorrência.
- Mensagens malformadas (sem `message_id`, `type` ou campos obrigatórios, `version` ≠ 1, JSON inválido) são registradas no
  log e puladas, sem resposta.

### 4.4 Saga de inscrição (o que se espera de Inscrições)

1. Criar a inscrição `PENDING` e publicar `registration.requested`.
2. `seat.reserved` com `paid = false` → confirmar. Com `paid = true` → iniciar o pagamento de `price_cents` (`currency`).
3. Pagamento recusado ou expirado (RN02/RN03), ou cancelamento pelo participante → publicar `registration.expired` ou
   `registration.cancelled`; Eventos libera a vaga.
4. `seat.rejected` com `reason = FULL` e `waitlist_enabled = true` → lista de espera; senão, recusar.
5. `seat.released` → oferecer a vaga ao próximo da lista publicando o `registration.requested` dele (RN04).
6. `event.cancelled` → cancelar as inscrições do evento (e publicar `registration.cancelled` das que tinham vaga).

## 5. Integração com a infraestrutura

| Com | Contrato |
|---|---|
| Service-discoverer | Registra `{"kind":"events","host":"<SERVICE_HOST>"}` em `POST /register` ao iniciar e a cada 30 s; `GET /healthcheck` responde 200 só com o banco migrado e acessível. |
| Gateway | Lê `GET /openapi.json`. As rotas da seção 3 são abertas por `events/scripts/register-gateway-routes.sh` com `isPublic=true`, `requireAuth=false` (a autenticação é feita no serviço) e `rateLimitBy=ip`. Quando o Gateway validar o JWT e injetar `X-User-Id` (P3), as rotas de escrita podem passar a `requireAuth=true` e `rateLimitBy=user_or_ip`. |
| Serviço de Usuários | `GET http://<host de consult?kind=user>/.well-known/jwks.json` (ou `JWT_JWKS_URL`); exige `alg=RS256`, `kid`, `iss = JWT_ISSUER` (`eventhub-users`), `exp`, `sub`; lê `roles`. |
