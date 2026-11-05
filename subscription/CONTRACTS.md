# Contratos de integração de Inscrições — v1

Estes contratos são implementados **no lado consumidor/produtor de Inscrições**. As APIs de
Eventos e Pagamentos abaixo são propostas para a equipe, não endpoints já existentes no
monorepo. Usuários, Gateway, Discoverer e o formato de Notificações seguem o código existente.

## Descoberta, identidade e HTTP

- Registro periódico: `POST {SERVICE_DISCOVERER_URL}/register`
  com `{"kind":"subscription","host":"host:8080"}`.
- Resolução: `GET /consult?kind=events|payments|user` → `{"host":"host:8080"}`.
- HTTP externo tem timeout de 5 segundos, sem retry de mutações HTTP.
- Identidade: o gateway verifica o JWT e envia `X-User-Id` (UUID do `sub`) e `X-User-Roles`
  (separados por vírgula; ausente sem papéis). Inscrições não valida JWT e só aceita a
  identidade desses cabeçalhos (401 `UNAUTHENTICATED` se `X-User-Id` faltar ou for inválido).
- Chamadas a Eventos feitas em nome de um usuário enviam `X-User-Id`, `X-User-Roles` (somente
  se houver papéis), `X-Request-Id` e o `Authorization` do usuário (repassado sem verificação).
  Chamadas de fundo (reação a `events.events`, reconciliação de pagamentos) não carregam identidade.
  Os endpoints `/internal/...` são protegidos por isolamento de rede, não por token.
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
inteiros não negativos (2500 = R$ 25,00 em BRL). Alteração de preço afeta apenas inscrições
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
| `payments.commands` | Inscrições | Pagamentos | registration_id |
| `payments.events` | Pagamentos | Inscrições | registration_id |
| `events.events` | Eventos | Inscrições / outros | activity_id |
| `subscription.events` | Inscrições | Certificados / Relatórios | registration_id |
| `notifications` | Inscrições / outros | Notificações | user_id |
| `subscription.dlq` | Inscrições | Operação/manual | tópico:partição |

Na inicialização, Inscrições cria os seis tópicos acima, se ausentes, com
`SUBSCRIPTION_TOPIC_PARTITIONS` partições (padrão 6) e nunca altera tópicos existentes; se o Kafka
estiver indisponível, repete em segundo plano até conseguir, antes de consumir ou publicar.
Cada serviço consumidor usa grupo próprio; Inscrições usa `subscription-service`.
Não alterar partições durante processamento que dependa da ordenação da chave sem planejar
a migração. A correção financeira também usa versão, não apenas a ordem Kafka.

Variáveis: `PAYMENT_COMMANDS_TOPIC`, `PAYMENT_EVENTS_TOPIC`, `EVENTS_TOPIC`,
`SUBSCRIPTION_EVENTS_TOPIC`, `NOTIFICATIONS_TOPIC`, `SUBSCRIPTION_DLQ_TOPIC`.

## Comandos financeiros

```json
{
  "event_id": "33333333-3333-4333-8333-333333333333",
  "schema_version": 1,
  "type": "PaymentRequested",
  "idempotency_key": "44444444-4444-4444-8444-444444444444:PaymentRequested",
  "payment_attempt_id": "44444444-4444-4444-8444-444444444444",
  "registration_id": "55555555-5555-4555-8555-555555555555",
  "user_id": "66666666-6666-4666-8666-666666666666",
  "amount_minor": 2500,
  "currency": "BRL",
  "expires_at": "2026-11-01T22:15:00+00:00"
}
```

Tipos: `PaymentRequested`, `PaymentCancelRequested`, `PaymentRefundRequested`.
`expires_at` pode ser null nos comandos de compensação. Inscrições fornece o ID da tentativa;
Pagamentos deve usá-lo para identificar a cobrança e devolver esse mesmo ID nos resultados.

**Deduplicar pela idempotency_key**, pois reconciliação pode gerar novo event_id para o mesmo
efeito financeiro. Mesmo comando repetido não cria outra cobrança/estorno. Cancelamento deve
impedir uma solicitação atrasada de reabrir uma tentativa; estorno deve concluir uma aprovação
concorrente ao cancelamento. Não confiar na ordem entre provedores/callbacks externos.

## Resultados financeiros

```json
{
  "event_id": "77777777-7777-4777-8777-777777777777",
  "schema_version": 1,
  "type": "PaymentApproved",
  "payment_attempt_id": "44444444-4444-4444-8444-444444444444",
  "registration_id": "55555555-5555-4555-8555-555555555555",
  "provider_version": 1,
  "amount_minor": 2500,
  "currency": "BRL"
}
```

Tipos: `PaymentApproved`, `PaymentDeclined`, `PaymentExpired`, `PaymentCancelled`, `PaymentRefunded`.
`provider_version` é crescente **por tentativa**, atribuído pelo serviço de Pagamentos após
normalizar os callbacks do provedor. Versões menores/iguais são ignoradas. Um snapshot mais
novo deve representar a verdade financeira atual, não apenas a última mensagem recebida.
Registro, tentativa, valor e moeda devem corresponder exatamente. Nenhum cliente HTTP público
pode enviar esse resultado diretamente à API de Inscrições.

Uma aprovação só confirma se a reserva estiver válida no relógio do banco durante o
processamento. Aprovação atrasada após liberação de vaga resulta em estorno, sem reativação.

## Reconciliação de Pagamentos

`GET /internal/payment-attempts/{payment_attempt_id}` deve devolver o mesmo JSON do último
resultado acima, com event_id e versão estáveis. Enquanto ainda não há resultado, devolver 404.
Não interpretar 404 como pagamento recusado. A consulta precisa continuar disponível para
cancelados/estornados, para resolver compensações após quedas e perda de mensagens.

Inscrições consulta `REQUESTED`, `CANCEL_PENDING`, `REFUND_PENDING` após `RECONCILE_SECONDS`.
Compensações pendentes são reenviadas com a mesma chave de idempotência.

## Ciclo de atividade

Eventos publica em `events.events`:

```json
{
  "event_id": "88888888-8888-4888-8888-888888888888",
  "schema_version": 1,
  "type": "ActivityEnded",
  "activity_id": "11111111-1111-4111-8111-111111111111"
}
```

Tipos: `ActivityEnded` e `ActivityCancelled`. O recurso deve continuar consultável por sua
API após encerramento/cancelamento. Encerramento antecipado à data final não é aplicado;
é repetido sem avançar o offset. Cancelamento é terminal e prevalece sobre encerramento.

## Eventos de Inscrições

Envelope: `event_id`, `schema_version=1`, `type`, `registration_id`, `activity_id`, `user_id`,
`aggregate_version`, `occurred_at`, `status`. Tipos:

- `RegistrationWaitlisted`, `WaitlistOffered`;
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

Campos adicionais (somente neste tipo; mudança aditiva, `schema_version` continua 1):
`parent_event_id` (id do evento no serviço de Eventos, uuid), `attended_activities` (int),
`total_activities` (int), `attendance_percentage` (número, até 2 casas). `event_id` continua sendo o
uuid da mensagem, nunca o id do evento de Eventos. `registration_id`/`activity_id`/`aggregate_version`
referem-se à inscrição da atividade cujo encerramento disparou a avaliação; a chave Kafka segue
`registration_id`.
Certificados permanece responsável pela emissão, idempotência e regras adicionais próprias.
Relatórios pode reconstruir projeções por esses eventos; nunca deve escrever no banco de Inscrições.
Consumidores deduplicam por event_id e usam aggregate_version para rejeitar estados antigos.

## Notificações existentes

Publicação compatível com `notifications/message.go`:

```json
{
  "user_id": "66666666-6666-4666-8666-666666666666",
  "message": "Sua inscrição foi confirmada.",
  "payload_type": "RegistrationConfirmed",
  "payload": {
    "event_id": "33333333-3333-4333-8333-333333333333",
    "registration_id": "55555555-5555-4555-8555-555555555555",
    "expires_at": null
  }
}
```

Não depende de resposta de Notificações para confirmar a inscrição. O serviço atual ignora
campos desconhecidos e deduplica somente por offset: mensagens republicadas em novos offsets
podem aparecer repetidas, conforme documentado no README.
