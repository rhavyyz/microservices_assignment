# Relatório do Serviço de Pagamentos

Plataforma de eventos em microsserviços · Serviço `payments` · Novembro de 2026

## 1. Objetivo e escopo

O serviço de pagamentos cuida do pagamento de atividades pagas (RF07). Ele inicia o pagamento de uma reserva, simula o provedor externo e registra a confirmação, a recusa ou a expiração. Também define quando uma reserva pode ser considerada paga (RN02) e garante que recusa e expiração nunca gerem confirmação indevida (RN03).

Fora do escopo desta versão: estorno de pagamento já confirmado, cobrança real em provedor externo e emissão de recibos.

## 2. Posição na arquitetura

| Componente | Relação com o serviço de pagamentos |
| --- | --- |
| API Gateway | Expõe ao front apenas a consulta e a simulação do pagamento. A criação (`POST /payments`) fica privada. |
| Service-discoverer | O serviço se registra com o kind `payments`. O serviço de inscrições o encontra por ele, sem endereço fixo. |
| Kafka | Barramento de eventos. O serviço publica em `payments-events` e `notifications` e consome `subscription-events`. |
| Serviço de inscrições | Cria o pagamento e reage aos eventos de resultado (confirma a inscrição ou libera a vaga). |
| Serviço de notificações | Recebe os avisos ao usuário pelo tópico `notifications`. |
| Serviço de relatórios | Consome `payments-events` para contar pagamentos e receita. |
| Banco próprio | PostgreSQL `payments-db`, que nenhum outro serviço acessa (database per service). |

## 3. Tecnologias

Node.js 22 com TypeScript, Fastify (contrato OpenAPI gerado pelo código), PostgreSQL 16, Kafka (kafkajs) e Docker. A escolha atende o RQ05: o gateway é em Go e os serviços usam linguagens diferentes, então a integração acontece só por contratos explícitos (REST com OpenAPI e eventos JSON versionados).

## 4. Modelo de dados e estados

| Tabela | Função |
| --- | --- |
| `payments` | Um pagamento por inscrição (`registration_id` único), com valor, moeda, estado e prazo (`expires_at`). |
| `payment_transitions` | Histórico de toda mudança de estado: de, para, motivo e `correlation_id`. |
| `outbox` | Eventos a publicar no Kafka, gravados na mesma transação da mudança de estado. |
| `processed_messages` | `message_id` das mensagens já tratadas (consumidor idempotente). |

Máquina de estados:

```
PENDING -> CONFIRMED | REFUSED | EXPIRED | CANCELLED      (os quatro são finais)
```

Regras:

- Um pagamento final nunca muda. Repetir o mesmo pedido não tem efeito.
- Uma confirmação que chega depois do prazo não vale: o pagamento vira `EXPIRED` e sai `payment.expired` (RN03).
- Recusa e expiração liberam a vaga sem gerar confirmação, porque o serviço de inscrições só confirma ao receber `payment.confirmed`.
- Todo pagamento é identificado por UUID gerado pelo serviço.

## 5. Interface: o que o serviço recebe

### REST

| Endpoint | Quem chama | Gateway | Função |
| --- | --- | --- | --- |
| `POST /payments` | Serviço de inscrições, pelo discoverer | Privado | Inicia o pagamento de uma reserva (idempotente por `registration_id`). |
| `GET /payments/{paymentId}` | Front | Público com autenticação | Consulta o estado do pagamento. |
| `GET /payments?registration_id=...` | Front ou inscrições | Público com autenticação | Busca o pagamento de uma inscrição. |
| `POST /payments/{paymentId}/simulate` | Front (demonstração e testes) | Público com autenticação | Provedor simulado: `confirm`, `refuse` ou `expire`. |

Corpo de `POST /payments`:

```json
{"registration_id":"...","user_id":"...","event_id":"...","activity_id":"...",
 "amount":50.00,"currency":"BRL","expires_at":"2026-11-03T12:15:00Z"}
```

O valor deve ser maior que zero, com no máximo duas casas decimais. O prazo `expires_at` deve estar no futuro e coincidir com o prazo da reserva, para as duas expirarem juntas. Repetir a chamada devolve o pagamento existente (200 em vez de 201); a mesma inscrição com usuário ou valor diferente resulta em 409.

As consultas e a simulação exigem o cabeçalho `X-User-Id` e só respondem ao dono do pagamento. Qualquer outro usuário recebe 404, igual a um pagamento inexistente (RN07). A simulação responde 409, com o estado real, quando o pedido não pôde ser atendido.

### Kafka

Tópico `subscription-events`, grupo `payments-service`, consumo idempotente pelo `message_id`:

| Tipo | Dado obrigatório | Efeito |
| --- | --- | --- |
| `registration.cancelled`, `registration.expired` | `registration_id` | Cancela o pagamento da inscrição se ainda estiver `PENDING`. Pagamento já final é preservado. |

## 6. Interface: o que o serviço envia

### Tópico `payments-events` (chave: `registration_id`)

Eventos `payment.created`, `payment.confirmed`, `payment.refused`, `payment.expired` e `payment.cancelled`, em envelope versionado (`message_id`, `type`, `version`, `occurred_at`, `correlation_id`, `data`). O campo `data` traz `payment_id`, `registration_id`, `user_id`, `event_id`, `activity_id`, `amount`, `currency`, `status` e `reason`.

O campo `reason` explica a causa: `simulated_confirmation`, `simulated_refusal`, `simulated_expiration`, `payment_deadline` (prazo vencido), `expired_before_confirmation` (confirmação tardia), `registration_cancelled` e `registration_expired`.

Quem consome:

- Serviço de inscrições: confirma a inscrição em `payment.confirmed` e libera a vaga em `payment.refused` e `payment.expired`.
- Serviço de relatórios: conta pagamentos por estado e a receita dos confirmados.

### Tópico `notifications` (chave: `user_id`)

No formato do serviço de notificações (`user_id`, `message`, `payload` e `payload_type`). O usuário é avisado quando o pagamento é confirmado, recusado ou expira. Pagamento recém-criado e cancelamento feito pelo próprio usuário não geram aviso.

## 7. Fluxos principais

**Pagamento aprovado**

1. A inscrição reserva a vaga e chama `POST /payments`. O pagamento nasce `PENDING`.
2. O usuário paga (na demonstração, `simulate` com `confirm`).
3. O pagamento vira `CONFIRMED`. O evento `payment.confirmed` e o aviso ao usuário vão para a outbox na mesma transação.
4. O worker envia à Kafka e a inscrição passa a `CONFIRMED`.

**Pagamento recusado ou expirado**

1. O pagamento vira `REFUSED` (recusa) ou `EXPIRED` (o job de expiração roda a cada 5 segundos e encontra o prazo vencido).
2. Sai `payment.refused` ou `payment.expired`, e o usuário é avisado.
3. O serviço de inscrições libera a vaga. Nenhuma confirmação é gerada (RN03).

**Confirmação tardia**

Se a confirmação chega depois do prazo, o serviço não a honra. O pagamento vira `EXPIRED` e a resposta ao chamador é 409.

**Inscrição cancelada antes de pagar**

O serviço de inscrições publica `registration.cancelled`. O pagamento pendente vira `CANCELLED` e sai `payment.cancelled`.

## 8. Padrões de arquitetura aplicados

| Padrão | Como foi aplicado | Situação |
| --- | --- | --- |
| Database per service | PostgreSQL próprio, sem acesso de outros serviços | Implementado |
| API Gateway | Rotas de front liberadas por endpoint; criação privada | Implementado (liberação por script de administrador) |
| Server-side discovery | Registro no discoverer com o protocolo bruto e a mesma política de retentativa das bibliotecas (10 tentativas, 1 s até 30 s) | Implementado |
| Messaging com consumidor idempotente | `message_id` gravado na mesma transação do efeito | Implementado |
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
| RN02 Pagamento e confirmação | O serviço só emite `payment.confirmed` dentro do prazo. A confirmação da inscrição depende do serviço de inscrições. |
| RN03 Pagamento recusado | Recusa e expiração geram evento de liberação, nunca de confirmação; confirmação tardia vira expiração. |
| RN07 Segurança e acesso | O usuário só acessa o próprio pagamento. |
| RQ01 Evolução independente | Serviço isolado, com banco, contratos e implantação próprios. |
| RQ02 Escalabilidade seletiva | Pode ter réplicas. O job de expiração usa bloqueio sem espera (`SKIP LOCKED`); a outbox serializa os envios para manter a ordem por chave. |
| RQ03 Resiliência | O serviço sobe e responde sem Kafka. Os eventos aguardam na outbox até o Kafka voltar. |
| RQ04 Consistência | Transições controladas por máquina de estados, com bloqueio de linha e evento na mesma transação. |
| RQ05 Interoperabilidade | REST com OpenAPI e eventos JSON versionados. |
| RQ06 Observabilidade | Logs estruturados e `correlation_id` em requisições, eventos e histórico de transições. |
| RQ07 Segurança | Senha do banco por variável de ambiente (o valor de desenvolvimento no compose deve ser trocado fora do repositório). |
| RQ08 Operabilidade | Dockerfile, compose com o banco e README com instruções. |

## 10. Testes e validação

Testes unitários (17, todos passando): máquina de estados, incluindo a confirmação tardia; montagem dos eventos e das notificações; validação do corpo de `POST /payments` e das mensagens do Kafka; registro no discoverer e retentativas.

A validação com Postgres e Kafka reais ainda precisa ser executada e registrada: criação de pagamento, simulação de confirmação, recusa e expiração, expiração automática pelo job, cancelamento por `registration.cancelled`, idempotência e comportamento com o Kafka parado.

## 11. Limitações e próximos passos

- Não há estorno de pagamento já confirmado: se a inscrição for cancelada depois de paga, o pagamento continua `CONFIRMED`.
- Não há autenticação entre serviços; o `POST /payments` é protegido apenas por não estar público no gateway.
- Exception tracking e audit log dependem de decisão do grupo sobre a ferramenta e o formato do evento.
- Em caso de queda entre o envio e a marcação da outbox, o mesmo evento ou aviso pode ser enviado duas vezes. Os consumidores precisam deduplicar por `message_id`.
- Moedas diferentes são guardadas, mas o serviço não faz conversão.
- Falta o teste automatizado de integração com banco e broker.

## 12. Dependências com os outros serviços

Para a RN02 e a RN03 fecharem, o serviço de inscrições precisa:

1. Chamar `POST /payments` ao criar a reserva, com o mesmo prazo da reserva em `expires_at`.
2. Consumir `payment.confirmed`, `payment.refused` e `payment.expired` do `payments-events`.
3. Publicar `registration.cancelled` (e `registration.expired`, se existir) em `subscription-events`.

O administrador do gateway precisa liberar as três rotas de consulta e simulação.

## 13. Como executar

```
docker compose -f gateway/docker-compose.yml up -d
docker compose up --build kafka service-discoverer gateway payments payments-db
```

Testes unitários: `npm install` e `npm test` dentro da pasta `payments/`. Variáveis de ambiente, contratos completos e o script de liberação das rotas estão no `README.md` do serviço.
