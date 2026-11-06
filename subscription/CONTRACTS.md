# Contratos de integração de Inscrições — v1

Estes contratos são implementados **no lado consumidor/produtor de Inscrições**. As APIs e
mensagens de Eventos abaixo são **implementadas por Eventos** (ver ADR-008). Pagamentos reage aos eventos de Inscrições e lê fatos pelo endpoint interno descrito adiante. Usuários, Gateway, Discoverer e o formato de Notificações seguem o código existente.

## Descoberta, identidade e HTTP

- Registro periódico: `POST {SERVICE_DISCOVERER_URL}/register`
  com `{"kind":"subscription","host":"host:8080"}`.
- Resolução: `GET /consult?kind=events|user` → `{"host":"host:8080"}`.
- HTTP externo tem timeout de 5 segundos, sem retry de mutações HTTP.
- Identidade: o gateway verifica o JWT e envia `X-User-Id` (UUID do `sub`) e `X-User-Roles`
  (separados por vírgula; ausente sem papéis). Inscrições não valida JWT e só aceita a
  identidade desses cabeçalhos (401 `UNAUTHENTICATED` se `X-User-Id` faltar ou for inválido).
- Chamadas a Eventos feitas em nome de um usuário enviam `X-User-Id`, `X-User-Roles` (somente
  se houver papéis), `X-Trace-Id` e o `Authorization` do usuário (repassado sem verificação; Eventos o ignora e lê só `X-User-Id`/`X-User-Roles`).
  Chamadas de fundo (reação a `events.events` e a `payments.events`) não carregam identidade.
  Os endpoints `/internal/...` são protegidos por isolamento de rede, não por token; ficam fora do
  OpenAPI e do `scripts/register_gateway.py`, e não são destinados ao Gateway.
- O broker atual é PLAINTEXT em rede compartilhada. Resultados financeiros só são confiáveis
  se clientes públicos não puderem produzir nesses tópicos; ACLs/credenciais no broker são
  responsabilidade da infraestrutura e não foram adicionadas aos outros serviços.

## Eventos: atividade

`GET /api/v1/activities/{activity_id}` → 200:

```json
{
  "activity_id": "11111111-1111-4111-8111-111111111111",
  "event_id": "22222222-2222-4222-8222-222222222222",
  "capacity": 100,
  "amount_minor": 2500,
  "currency": "BRL",
  "registration_open": true,
  "waitlist_enabled": true,
  "starts_at": "2026-12-01T12:00:00Z",
  "ends_at": "2026-12-01T18:00:00Z"
}
```

`capacity` nunca muda. O serviço não recebe nem devolve contagem de ocupação para Eventos.
Inscrições valida igualdade do ID retornado. Datas exigem fuso; valores monetários são
inteiros não negativos (2500 = R$ 25,00 em BRL). Eventos devolve também campos descritivos
(`title`, `description`, `speaker`, `location`, `paid`, `lifecycle`, `ended_at`, `created_at`,
`updated_at`); Inscrições os **ignora** e exige apenas os campos acima. Alteração de preço afeta apenas inscrições
criadas posteriormente; inclusive a fila preserva o valor originalmente apresentado.

`GET /api/v1/activities/{activity_id}/permissions/me`, com Bearer do organizador:

```json
{"can_manage": true}
```

403, `false` ou erro não autorizam acesso. A autorização é consultada em cada operação
administrativa; o papel `ORGANIZER` sozinho não concede acesso a todos os eventos.

## Kafka: tópicos

| Tópico padrão | Produtor | Consumidor | Chave |
|---|---|---|---|
| `payments.events` | Pagamentos | Inscrições | registration_id |
| `events.events` | Eventos | Inscrições / outros | `activity_id` (`ActivityEnded`/`ActivityCancelled`); `event_id` (demais tipos) |
| `subscription.events` | Inscrições | Pagamentos / Certificados / Relatórios | registration_id |
| `notifications` | Inscrições / outros | Notificações | user_id |
| `subscription.dlq` | Inscrições | Operação/manual | tópico:partição |

Na inicialização, Inscrições cria os cinco tópicos acima, se ausentes, com
`SUBSCRIPTION_TOPIC_PARTITIONS` partições (padrão 6) e nunca altera tópicos existentes; se o Kafka
estiver indisponível, repete em segundo plano até conseguir, antes de consumir ou publicar.
Cada serviço consumidor usa grupo próprio; Inscrições usa `subscription-service`.
Não alterar partições durante processamento que dependa da ordenação da chave sem planejar
a migração.

Variáveis: `PAYMENT_EVENTS_TOPIC`, `EVENTS_TOPIC`,
`SUBSCRIPTION_EVENTS_TOPIC`, `NOTIFICATIONS_TOPIC`, `SUBSCRIPTION_DLQ_TOPIC`.

## Modelo declarativo: Inscrições não comanda Pagamentos

Inscrições **não envia comandos nem chama Pagamentos**. Ela publica apenas os próprios eventos de
domínio em `subscription.events` e aguarda os resultados em `payments.events`. Pagamentos reage:

- ignora `RegistrationPendingPayment`: a cobrança é criada pelo participante em `POST /payments`
  (só com o `registration_id`), e Pagamentos lê os fatos em
  `GET /internal/registrations/{registration_id}` (abaixo), mantendo a própria expiração;
- cancela a cobrança pendente ao ver `RegistrationCancelled`/`RegistrationExpired` e estorna uma
  cobrança já aprovada (inclusive aprovação tardia, vista depois do cancelamento/expiração).

Não há `payments.commands`, tentativa financeira local, chave de idempotência, reconciliação nem
endpoint de consulta financeira. O prazo da reserva de Inscrições (`RESERVATION_SECONDS`) é a
autoridade sobre a vaga.

### Endpoint interno para Pagamentos

`GET /internal/registrations/{registration_id}` → 200, sem autenticação (isolamento de rede):

```json
{
  "registration_id": "55555555-5555-4555-8555-555555555555",
  "activity_id": "11111111-1111-4111-8111-111111111111",
  "user_id": "66666666-6666-4666-8666-666666666666",
  "status": "PENDING_PAYMENT",
  "amount_minor": 2500,
  "currency": "BRL",
  "expires_at": "2026-11-01T22:15:00Z",
  "event_id": "88888888-8888-4888-8888-888888888888"
}
```

`activity_id` é a atividade da inscrição (sempre presente). `status` é o estado da inscrição (`PENDING_PAYMENT`, `CONFIRMED`, ...). `expires_at` é null fora de
`OFFERED`/`PENDING_PAYMENT`. `event_id` é o id do evento de Eventos ao qual a atividade pertence
(`event_id` da atividade, gravado na criação da inscrição); é null em inscrições anteriores à migração
`004` (a coluna se chamava `parent_event_id` até a migração `006`). Id desconhecido ou que não seja UUID → 404 `REGISTRATION_NOT_FOUND` (`application/problem+json`).
`message_id` identifica a mensagem Kafka; `event_id` é o evento de Eventos.

## Resultados financeiros

Pagamentos publica em `payments.events` mensagens planas:

```json
{
  "message_id": "77777777-7777-4777-8777-777777777777",
  "schema_version": 1,
  "type": "PaymentApproved",
  "registration_id": "55555555-5555-4555-8555-555555555555",
  "amount_minor": 2500,
  "currency": "BRL",
  "trace_id": "req-a1b2c3d4"
}
```

Tipos: `PaymentCreated`, `PaymentApproved`, `PaymentDeclined`, `PaymentExpired`, `PaymentCancelled`,
`PaymentRefunded`. Obrigatórios: `message_id`, `schema_version` (1), `type`, `registration_id`,
`amount_minor` (inteiro >= 0) e `currency` (texto, sem validação de padrão em Inscrições).
`trace_id` é opcional/nulo (string de 8–64 caracteres `[A-Za-z0-9._-]` quando presente) e é propagado
aos eventos resultantes. Campos adicionais são ignorados. Mensagem inválida vai para a DLQ.
Inscrições deduplica por `message_id`. Nenhum cliente HTTP público pode enviar esse resultado.

Regras aplicadas sob o lock da atividade, com o relógio do banco:

| Tipo | Efeito em Inscrições |
|---|---|
| `PaymentApproved` | Se a inscrição está `PENDING_PAYMENT`, dentro da reserva (`expires_at` não passou) e `amount_minor`/`currency` iguais ao snapshot: `CONFIRMED` e `RegistrationConfirmed`. Caso contrário é ignorada, sem erro; Pagamentos estorna por conta própria ao ver o evento de cancelamento/expiração. |
| `PaymentDeclined` | Se `PENDING_PAYMENT`: `REJECTED`, `RegistrationRejected`, libera a vaga e promove a fila. |
| `PaymentCreated`, `PaymentExpired`, `PaymentCancelled`, `PaymentRefunded` | Informativos: nenhuma mudança de estado. |
| `registration_id` desconhecido | Ignorado (não vai para a DLQ). |

## Ciclo de atividade

Eventos publica em `events.events`:

```json
{
  "message_id": "88888888-8888-4888-8888-888888888888",
  "schema_version": 1,
  "type": "ActivityEnded",
  "occurred_at": "2026-12-02T18:00:00Z",
  "trace_id": "req-a1b2c3d4",
  "activity_id": "11111111-1111-4111-8111-111111111111",
  "event_id": "22222222-2222-4222-8222-222222222222",
  "ends_at": "2026-12-01T18:00:00Z"
}
```

Eventos publica um envelope plano (`message_id`, `schema_version` 1, `type`, `occurred_at`, `trace_id`, ...)
com todos os seus tipos: `ActivityEnded`, `ActivityCancelled`, `EventCreated`, `EventUpdated`,
`EventPublished`, `EventCancelled`, `ActivityCreated`, `ActivityUpdated` e `ActivityDeleted`. Inscrições
trata só `ActivityEnded` e `ActivityCancelled` (obrigatório `activity_id`; demais campos ignorados) e
**ignora os outros tipos**: a mensagem é confirmada sem DLQ. Vão para a DLQ (`INVALID_CONTRACT`) apenas
mensagens inválidas: não JSON, `schema_version` diferente de 1, `message_id` ou `type` ausente/inválido, ou
`activity_id` ausente/inválido num tipo tratado. Inscrições deduplica por `message_id`. O recurso deve continuar consultável por sua
API após encerramento/cancelamento. Encerramento antecipado à data final não é aplicado;
é repetido sem avançar o offset. Cancelamento é terminal e prevalece sobre encerramento.

## Eventos de Inscrições

Envelope: `message_id`, `schema_version=1`, `type`, `registration_id`, `activity_id`, `user_id`,
`aggregate_version`, `occurred_at`, `status`, `event_id`, `trace_id` (opcional/nulo em trabalho de fundo; Pagamentos
devolve o mesmo valor nos resultados; ausente das mensagens de Notificações). `occurred_at` (e qualquer
data/hora nos payloads) é ISO 8601 com offset, por exemplo `2026-11-04T12:00:00.123456+00:00`.
`event_id` (uuid) é o id do evento no serviço de Eventos ao qual a atividade pertence; está presente em
**todos** os tipos abaixo e é não nulo desde a migração 007 (que preenche inscrições antigas a partir de
`activity_inventory`). Nunca é o `message_id`. Tipos:

- `RegistrationWaitlisted`, `WaitlistOffered`;
- `RegistrationPendingPayment` (a inscrição entrou em `PENDING_PAYMENT`: inscrição paga com vaga ou
  aceite de oferta paga; sem campos extras — Pagamentos lê os fatos no endpoint interno);
- `RegistrationConfirmed`, `RegistrationCancelled`, `RegistrationExpired`, `RegistrationRejected`;
- `AttendanceRecorded`, `AttendanceEligible`.

`AttendanceEligible` (RN06) é por pessoa e **evento** e só é emitido quando a regra é atendida:
percentual de presença >= `ATTENDANCE_MIN_PERCENT` (padrão 75; número em (0, 100]), onde
percentual = atividades do evento com inscrição confirmada e check-in ÷ atividades do evento com
inscrição confirmada. É avaliado quando a última atividade confirmada da pessoa no evento encerra
(`ActivityEnded`) ou é cancelada (`ActivityCancelled`; a cancelada não entra na conta e, sem atividades
restantes, nada é emitido);
abaixo do mínimo nada é publicado. Emitido no máximo uma vez por (pessoa, evento)
(`event_attendance_emitted`): a primeira conclusão vence, e inscrição confirmada tardiamente em
outra atividade do mesmo evento não gera segunda emissão (limitação conhecida). Atividades
encerradas antes da migração 003 não são reavaliadas.

Campos adicionais (somente neste tipo; mudança aditiva, `schema_version` continua 1; o `event_id` já
está no envelope de todos os tipos, com o mesmo valor): `attended_activities` (int),
`total_activities` (int), `attendance_percentage` (número, até 2 casas). `message_id` continua sendo o
uuid da mensagem, nunca o id do evento de Eventos. `registration_id`/`activity_id`/`aggregate_version`
referem-se à inscrição da atividade cujo encerramento disparou a avaliação; a chave Kafka segue
`registration_id`.
Certificados permanece responsável pela emissão, idempotência e regras adicionais próprias.
Relatórios pode reconstruir projeções por esses eventos; nunca deve escrever no banco de Inscrições.
Consumidores deduplicam por message_id e usam aggregate_version para rejeitar estados antigos.

## Notificações existentes

Publicação compatível com `notifications/message.go`:

```json
{
  "user_id": "66666666-6666-4666-8666-666666666666",
  "message": "Sua inscrição foi confirmada.",
  "payload_type": "RegistrationConfirmed",
  "payload": {
    "message_id": "33333333-3333-4333-8333-333333333333",
    "registration_id": "55555555-5555-4555-8555-555555555555",
    "expires_at": null
  }
}
```

Não depende de resposta de Notificações para confirmar a inscrição. O serviço atual ignora
campos desconhecidos e deduplica somente por offset: mensagens republicadas em novos offsets
podem aparecer repetidas, conforme documentado no README.
