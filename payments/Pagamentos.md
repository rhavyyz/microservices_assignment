# Relatório do Serviço de Pagamentos

Plataforma de eventos em microsserviços · Serviço `payments` · Novembro de 2026

## 1. Objetivo e escopo

O serviço de pagamentos cuida do pagamento de atividades pagas (RF07). Ele inicia o pagamento de uma reserva, simula o provedor externo e registra a aprovação, a recusa ou a expiração. Também define quando uma reserva pode ser considerada paga (RN02) e garante que recusa e expiração nunca gerem confirmação indevida (RN03).

O serviço é reativo: cria o pagamento por conta própria (consultando o serviço de inscrições por HTTP) e reage aos eventos de domínio de `subscription.events` para cancelar ou estornar. Não há tópico de comandos, e o serviço de inscrições não chama o de pagamentos. O prazo do pagamento é do próprio serviço (`PAYMENT_TTL_SECONDS`, 900 s por padrão).

Fora do escopo desta versão: cobrança real em provedor externo e emissão de recibos.

## 2. Posição na arquitetura

| Componente | Relação com o serviço de pagamentos |
| --- | --- |
| API Gateway | Expõe ao front a criação, a consulta e a simulação do pagamento. A rota `POST /payments` ainda precisa ser liberada por um script de administrador (fora do escopo deste serviço). |
| Service-discoverer | O serviço se registra com o kind `payments` e encontra o serviço de inscrições pelo kind `subscription`, sem endereço fixo. |
| Kafka | Barramento de eventos. O serviço consome `subscription.events` e publica em `payments.events` e `notifications`. Na inicialização cria, se não existirem, os três tópicos. |
| Serviço de inscrições | Fornece os fatos da inscrição em `GET /internal/registrations/{id}` (endpoint dele), publica `subscription.events` e reage aos eventos de resultado (confirma a inscrição ou libera a vaga). |
| Serviço de notificações | Recebe os avisos ao usuário pelo tópico `notifications`. |
| Serviço de relatórios | Consome `payments.events` para contar pagamentos e receita. |
| Banco próprio | PostgreSQL `payments-db`, que nenhum outro serviço acessa (database per service). |

## 3. Tecnologias

Node.js 22 com TypeScript, Fastify (contrato OpenAPI gerado pelo código), PostgreSQL 16, Kafka (kafkajs) e Docker. A escolha atende o RQ05: o gateway é em Go e os serviços usam linguagens diferentes, então a integração acontece só por contratos explícitos (REST com OpenAPI e eventos JSON versionados).

## 4. Modelo de dados e estados

| Tabela | Função |
| --- | --- |
| `payments` | Um pagamento por inscrição (`registration_id` único), com valor, moeda, estado e prazo (`expires_at`). |
| `payment_transitions` | Histórico de toda mudança de estado: de, para, motivo e identificador de rastreio (`trace_id`). |
| `outbox` | Eventos a publicar no Kafka, gravados na mesma transação da mudança de estado. |
| `processed_messages` | `message_id` das mensagens já tratadas (deduplicação do consumidor de `subscription.events`). |

Máquina de estados:

```
PENDING  -> APPROVED | DECLINED | EXPIRED | CANCELLED
APPROVED -> REFUNDED
DECLINED, EXPIRED, CANCELLED e REFUNDED são finais
```

Regras:

- O estorno (`REFUNDED`) só vale para pagamento `APPROVED`, é automático (não há simulação) e nunca se aplica a `PENDING`, `DECLINED`, `EXPIRED` ou `CANCELLED`.
- Um pagamento final nunca muda. Repetir o mesmo pedido não tem efeito.
- Uma confirmação que chega depois do prazo não vale: o pagamento vira `EXPIRED` e sai `PaymentExpired` (RN03).
- Recusa e expiração liberam a vaga sem gerar confirmação, porque o serviço de inscrições só confirma ao receber `PaymentApproved`.
- Todo pagamento é identificado por UUID gerado pelo serviço.

## 5. Interface: o que o serviço recebe

### REST

| Endpoint | Quem chama | Gateway | Função |
| --- | --- | --- | --- |
| `POST /payments` | Front (participante) | A liberar por script de administrador | Inicia o pagamento de uma inscrição (idempotente por `registration_id`). |
| `GET /payments/{paymentId}` | Front | Público com autenticação | Consulta o estado do pagamento. |
| `GET /payments?registration_id=...` | Front ou inscrições | Público com autenticação | Busca o pagamento de uma inscrição. |
| `POST /payments/{paymentId}/simulate` | Front (demonstração e testes) | Público com autenticação | Provedor simulado: `approve`, `decline` ou `expire`. |

Corpo de `POST /payments`:

```json
{"registration_id":"<uuid>"}
```

Só `registration_id` é lido (ausente ou fora do formato UUID resulta em 400 `VALIDATION_ERROR`); propriedades desconhecidas são ignoradas. Valor, moeda, dono e evento de origem vêm sempre da resposta do serviço de inscrições (`GET /internal/registrations/{id}`, endpoint dele, descoberto pelo kind `subscription` e chamado com o `X-Trace-Id` do pedido), nunca do cliente. Resultados:

- inscrição inexistente ou de outro usuário: 404 `REGISTRATION_NOT_FOUND` (nunca revela inscrições alheias);
- inscrição que não está em `PENDING_PAYMENT`: 409 `REGISTRATION_NOT_PAYABLE`;
- inscrição cujo `expires_at` (reserva) não está no futuro pelo relógio do Pagamentos, verificado depois do dono e do estado (o worker de expiração do Subscription pode atrasar alguns segundos): 409 `REGISTRATION_NOT_PAYABLE`;
- serviço de inscrições fora do ar, com erro 5xx ou resposta inválida: 503 `UPSTREAM_UNAVAILABLE`, sem detalhes internos;
- caso contrário, o pagamento nasce `PENDING` com prazo `agora + PAYMENT_TTL_SECONDS` (prazo próprio do serviço).

O host do serviço de inscrições fica em cache; numa falha de conexão o discoverer é consultado de novo e a chamada repetida uma vez (timeout de 5 s). Repetir a chamada devolve o pagamento existente, sem consultar as inscrições (200 em vez de 201), após a checagem do dono.

As consultas e a simulação exigem o cabeçalho `X-User-Id`, que deve ser um UUID (ausente ou inválido resulta em 401 `UNAUTHENTICATED`), e só respondem ao dono do pagamento. Qualquer outro usuário recebe 404, igual a um pagamento inexistente (RN07). A simulação responde 409 `PAYMENT_NOT_APPLIED`, com o estado real em `payment_status`, quando o pedido não pôde ser atendido.

O cabeçalho `X-Trace-Id` (8 a 64 caracteres de `[A-Za-z0-9._-]`, senão é gerado um UUID) é sempre devolvido na resposta e vira o `trace_id` dos eventos e do histórico. O antigo `X-Request-Id` é ignorado (não é lido nem devolvido). A migração v9 renomeia `payment_transitions.request_id` para `trace_id`. Todo erro sai como `application/problem+json` com `title`, `status`, `code` (`UNAUTHENTICATED`, `VALIDATION_ERROR`, `PAYMENT_NOT_FOUND`, `REGISTRATION_NOT_FOUND`, `REGISTRATION_NOT_PAYABLE`, `PAYMENT_NOT_APPLIED`, `UPSTREAM_UNAVAILABLE`, `INTERNAL_ERROR`), `detail` e `traceId` (o id de rastreio); o erro 500 não expõe detalhes internos.

### Kafka

O serviço consome `subscription.events` (variável `SUBSCRIPTION_TOPIC`; grupo `PAYMENTS_CONSUMER_GROUP`, padrão `payments-service`; leitura desde o início; atualização de metadados a cada 10 s). O envelope é plano; são obrigatórios `message_id`, `schema_version` (inteiro; maior que 1 é rejeitado), `type` e `registration_id`, e campos extras e tipos desconhecidos são tolerados. Mensagens inválidas são registradas em log (só identificadores, nunca o conteúdo) e puladas.

- `RegistrationCancelled` e `RegistrationExpired`: pagamento `PENDING` vira `CANCELLED`; pagamento `APPROVED` vira `REFUNDED` (motivos `registration_cancelled` e `registration_expired`). Qualquer outro estado, ou a ausência de pagamento, não tem efeito.
- Os demais tipos (inclusive `RegistrationPendingPayment`) são ignorados.
- A deduplicação é por `message_id` em `processed_messages`, gravado na mesma transação do efeito (entrega pelo menos uma vez). Erro de banco interrompe o processamento e o offset não é confirmado.

Na inicialização o serviço cria, se não existirem, `payments.events`, `notifications` e `subscription.events`. Não existe tópico `payments.commands`.

O `activity_id` saiu do serviço: o pagamento se relaciona com a inscrição, não com a atividade. A coluna antiga é removida na migração.

O serviço guarda no máximo um pagamento por `registration_id` (deduplicado por ele).

## 6. Interface: o que o serviço envia

### Tópico `payments.events` (chave: `registration_id`)

Eventos `PaymentCreated` (`PENDING`), `PaymentApproved` (`APPROVED`), `PaymentDeclined` (`DECLINED`), `PaymentExpired` (`EXPIRED`), `PaymentCancelled` (`CANCELLED`) e `PaymentRefunded` (`REFUNDED`), em envelope plano e versionado: `message_id` (id único da mensagem), `schema_version` (1), `type`, `occurred_at`, `trace_id`, `registration_id`, `amount_minor` (inteiro em unidades menores), `currency`, `payment_id`, `user_id`, `parent_event_id`, `status` e `reason`. O evento do serviço de eventos a que o pagamento pertence sai como `parent_event_id`, para não se confundir com `message_id`, que identifica a mensagem; na API HTTP e na coluna `payments.event_id` o campo é `event_id`. O `activity_id` não é mais publicado (o serviço de relatórios será atualizado à parte).

O campo `reason` explica a causa: `simulated_approval`, `simulated_decline`, `simulated_expiration`, `payment_deadline` (prazo vencido), `expired_before_confirmation` (aprovação tardia), `registration_cancelled` e `registration_expired`.

Quem consome:

- Serviço de inscrições: confirma a inscrição em `PaymentApproved` e libera a vaga em `PaymentDeclined` e `PaymentExpired`.
- Serviço de relatórios: conta pagamentos por estado e a receita dos confirmados.

### Tópico `notifications` (chave: `user_id`)

No formato do serviço de notificações (`user_id`, `message`, `payload` e `payload_type`). O usuário é avisado quando o pagamento é confirmado, recusado, expira ou é estornado. Pagamento recém-criado e cancelamento feito pelo próprio usuário não geram aviso.

## 7. Fluxos principais

**Pagamento aprovado**

1. O participante chama `POST /payments`; o serviço consulta a inscrição (`PENDING_PAYMENT`) e o pagamento nasce `PENDING`.
2. O usuário paga (na demonstração, `simulate` com `approve`).
3. O pagamento vira `APPROVED`. O evento `PaymentApproved` e o aviso ao usuário vão para a outbox na mesma transação.
4. O worker envia à Kafka e a inscrição passa a `CONFIRMED`.

**Pagamento recusado ou expirado**

1. O pagamento vira `DECLINED` (recusa) ou `EXPIRED` (o job de expiração roda a cada 5 segundos e encontra o prazo vencido).
2. Sai `PaymentDeclined` ou `PaymentExpired`, e o usuário é avisado.
3. O serviço de inscrições libera a vaga. Nenhuma confirmação é gerada (RN03).

**Aprovação tardia**

Se a aprovação chega depois do prazo, o serviço não a honra. O pagamento vira `EXPIRED` e a resposta ao chamador é 409.

**Inscrição cancelada ou expirada**

Ao receber `RegistrationCancelled` ou `RegistrationExpired` em `subscription.events`, o consumidor aplica a regra de inscrição encerrada (`closeForRegistration`): pagamento pendente vira `CANCELLED` (`PaymentCancelled`, sem aviso); pagamento aprovado vira `REFUNDED` (`PaymentRefunded` e aviso ao usuário); nos demais casos nada acontece.

## 8. Padrões de arquitetura aplicados

| Padrão | Como foi aplicado | Situação |
| --- | --- | --- |
| Database per service | PostgreSQL próprio, sem acesso de outros serviços | Implementado |
| API Gateway | Rotas de front liberadas por endpoint; criação privada | Implementado (liberação por script de administrador) |
| Server-side discovery | Registro no discoverer com o protocolo bruto e a mesma política de retentativa das bibliotecas (10 tentativas, 1 s até 30 s) | Implementado |
| Messaging com consumidor idempotente | `message_id` gravado na mesma transação do efeito (`processed_messages`), usado pelo consumidor de `subscription.events` | Implementado (sem teste com Kafka real) |
| Transactional outbox | Evento e mudança de estado na mesma transação; worker publica depois | Implementado |
| Health check API | `GET /healthcheck` responde 200 só se o banco responde ao ping, senão 503 | Implementado |
| Access token | Identidade por `X-User-Id` repassado pelo gateway, sem verificação, como no resto do monorepo; autorização por dono do pagamento | Parcial |
| Saga coreografada | Esta metade (estados, eventos, timeout, compensação por evento) está pronta; a outra depende do serviço de inscrições | Parcial |
| Exception tracking | Erros ficam registrados em log; ferramenta não definida pelo time | Pendente |
| Audit log | O histórico local existe em `payment_transitions`; falta o tópico e o consumidor central | Pendente |

## 9. Atendimento aos requisitos

| Requisito | Atendimento |
| --- | --- |
| RF07 Pagamentos | Provedor simulado com confirmação, recusa e expiração registradas. |
| RF08 Notificações | O serviço publica aviso de confirmação, recusa e expiração. Se o Kafka cair, os avisos esperam na outbox e não bloqueiam o pagamento. |
| RN02 Pagamento e confirmação | O serviço só emite `PaymentApproved` dentro do prazo. A confirmação da inscrição depende do serviço de inscrições. |
| RN03 Pagamento recusado | Recusa e expiração geram evento de liberação, nunca de confirmação; confirmação tardia vira expiração. |
| RN07 Segurança e acesso | O usuário só acessa o próprio pagamento. |
| RQ01 Evolução independente | Serviço isolado, com banco, contratos e implantação próprios. |
| RQ02 Escalabilidade seletiva | Pode ter réplicas. O job de expiração usa bloqueio sem espera (`SKIP LOCKED`); a outbox serializa os envios para manter a ordem por chave. |
| RQ03 Resiliência | O serviço sobe e responde sem Kafka. Os eventos aguardam na outbox até o Kafka voltar. |
| RQ04 Consistência | Transições controladas por máquina de estados, com bloqueio de linha e evento na mesma transação. |
| RQ05 Interoperabilidade | REST com OpenAPI e eventos JSON versionados. |
| RQ06 Observabilidade | Logs estruturados e `X-Trace-Id` (`trace_id`) em requisições, eventos e histórico de transições. |
| RQ07 Segurança | Senha do banco por variável de ambiente (o valor de desenvolvimento no compose deve ser trocado fora do repositório). |
| RQ08 Operabilidade | Dockerfile, compose com o banco e README com instruções. |

## 10. Testes e validação

Testes automatizados (58, todos passando, sem rede nem banco): máquina de estados, incluindo a aprovação tardia e o estorno; montagem dos eventos e das notificações; validação do corpo de `POST /payments`; `POST /payments` completo via `inject` com pool e consulta de inscrições falsos (criação, dono alheio, não pagável, upstream fora do ar, corpo inválido, idempotência); cliente de consulta (discoverer, cache, nova tentativa); consumidor de `subscription.events` com banco em memória (cancelamento, estorno, sem pagamento, estados finais, duplicata, mensagens inválidas ou desconhecidas); criação dos tópicos com admin falso; registro no discoverer e retentativas; valores padrão e validação de `PAYMENT_TTL_SECONDS`.

A validação com Postgres, Kafka e serviço de inscrições reais ainda precisa ser executada e registrada: a migração v7, o consumidor, o cliente HTTP, a criação ponta a ponta, a expiração automática pelo job, o estorno e o comportamento com o Kafka parado.

## 11. Limitações e próximos passos

- O estorno só muda o estado e avisa o usuário; não há devolução real de dinheiro (provedor simulado).
- Não há autenticação entre serviços; o `GET /internal/registrations/{id}` do serviço de inscrições deve ficar privado no gateway.
- Exception tracking e audit log dependem de decisão do grupo sobre a ferramenta e o formato do evento.
- Em caso de queda entre o envio e a marcação da outbox, o mesmo evento ou aviso pode ser enviado duas vezes. Os consumidores precisam deduplicar por `message_id`.
- Moedas diferentes são guardadas, mas o serviço não faz conversão.
- Falta o teste automatizado de integração com banco e broker.

## 12. Dependências com os outros serviços

Para a RN02 e a RN03 fecharem, o serviço de inscrições precisa:

1. Expor `GET /internal/registrations/{id}` (registro no discoverer com o kind `subscription`).
2. Publicar `RegistrationCancelled` e `RegistrationExpired` em `subscription.events`, com `message_id` único por mensagem.
3. Consumir `PaymentApproved`, `PaymentDeclined`, `PaymentExpired` e `PaymentRefunded` do `payments.events`.

O administrador do gateway precisa liberar as rotas de criação, consulta e simulação (a criação, `POST /payments`, é uma rota nova a liberar).

## 13. Como executar

```
docker compose -f gateway/docker-compose.yml up -d
docker compose up --build kafka service-discoverer gateway payments payments-db
```

Testes unitários: `npm install` e `npm test` dentro da pasta `payments/`. Variáveis de ambiente, contratos completos e o script de liberação das rotas estão no `README.md` do serviço.
