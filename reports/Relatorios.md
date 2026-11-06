# Relatório do Serviço de Relatórios

Plataforma de eventos em microsserviços · Serviço `reports` · Novembro de 2026

## 1. Objetivo e escopo

O serviço de relatórios entrega aos organizadores os indicadores do evento (RF11): inscrições, pagamentos, ocupação e comparecimento, por evento e por atividade. Ele responde à pergunta «como está o meu evento?».

O serviço só lê. Não cria nem altera inscrições, pagamentos ou eventos, e fica fora do caminho crítico: se ele cair, ninguém deixa de se inscrever ou de pagar (RQ03).

Fora do escopo desta versão: exportação de relatórios, filtros por período, gráficos e perfis de administrador.

## 2. Posição na arquitetura

| Componente | Relação com o serviço de relatórios |
| --- | --- |
| API Gateway | Expõe os endpoints de consulta ao front e repassa o `X-User-Id` do organizador. |
| Service-discoverer | O serviço se registra com o kind `reports`, e o gateway o encontra por ele. |
| Kafka | Fonte única de dados: o serviço consome os tópicos `events.events`, `subscription.events` e `payments.events`. Ele só publica na própria DLQ `reports.dlq`, referências de mensagens inválidas. |
| Serviço de eventos | Publica eventos e atividades (dono do evento, capacidade). |
| Serviço de inscrições | Publica inscrições e check-ins. |
| Serviço de pagamentos | Publica pagamentos e valores. |
| Banco próprio | PostgreSQL `reports-db`, que nenhum outro serviço acessa (database per service). |

O serviço nunca consulta o banco de outro serviço: tudo o que ele sabe vem dos eventos.

## 3. Tecnologias

Node.js 22 com TypeScript, Fastify (contrato OpenAPI gerado pelo código), PostgreSQL 16, Kafka (kafkajs) e Docker. A integração com o resto do sistema acontece só por contratos explícitos (REST com OpenAPI e eventos JSON versionados), o que atende o RQ05, já que o gateway é em Go e os serviços usam linguagens diferentes.

## 4. Modelo de leitura e cálculo dos indicadores

O banco é um modelo de leitura, montado só a partir dos eventos. Cada tabela guarda o último estado de uma entidade, nunca contadores:

| Tabela | Guarda |
| --- | --- |
| `events` | Evento, organizador (`organizer_id`), nome e status. |
| `activities` | Atividade, evento, capacidade e se é paga. |
| `registrations` | Último estado de cada inscrição. |
| `payments` | Último estado de cada pagamento, valor e moeda. |
| `checkins` | Um registro por inscrição com presença. |
| `processed_messages` | `message_id` de cada mensagem já tratada (idempotência). |

Os totais são calculados na hora da consulta, a partir desses estados. Por isso reentrega e mensagens fora de ordem não corrompem nenhum total.

Definições dos indicadores:

- **Vagas ocupadas:** inscrições `PENDING_PAYMENT`, `OFFERED` e `CONFIRMED` (um pagamento pendente e uma vaga oferecida já seguram a vaga no serviço de inscrições, RN02); a lista de espera (`WAITLISTED`) não segura vaga.
- **Taxa de ocupação:** vagas ocupadas dividido pela soma das capacidades das atividades.
- **Comparecimento:** check-ins dividido pelas inscrições confirmadas.
- **Receita:** soma dos pagamentos `APPROVED`, em centavos (`amount_minor`), agrupada por moeda: moedas diferentes nunca são somadas. Pagamentos sem moeda entram na moeda `UNKNOWN`. **Reembolsado:** soma dos pagamentos `REFUNDED`, também por moeda; um pagamento reembolsado deixa de ser `APPROVED` e sai da receita. Sem valores, a lista vem vazia.
- Quando o denominador é zero (por exemplo, capacidade zero), a taxa aparece vazia (`null`), e não zero.

## 5. Interface: o que o serviço recebe

O serviço não recebe chamadas de outros serviços. Recebe eventos pelo Kafka, em três tópicos (um por serviço de origem), em envelope plano: `message_id`, `schema_version` (1), `type` (PascalCase), `occurred_at` e `trace_id` ficam no nível de cima, ao lado dos campos do tipo (não existe objeto `data`; o formato antigo aninhado é rejeitado).

| Tópico | Tipo de evento | Campos obrigatórios | Campos opcionais |
| --- | --- | --- | --- |
| `events.events` | `EventCreated`, `EventUpdated` | `event_id` | `organizer_id`, `name`, `status`, `starts_at`, `ends_at` |
| `events.events` | `EventPublished`, `EventCancelled` | `event_id` | os mesmos (o status é forçado para `PUBLISHED` ou `CANCELLED`) |
| `events.events` | `ActivityCreated`, `ActivityUpdated` | `activity_id`, `event_id` | `name`, `capacity`, `paid` |
| `subscription.events` | `RegistrationWaitlisted` (`WAITLISTED`), `WaitlistOffered` (`OFFERED`), `RegistrationPendingPayment` (`PENDING_PAYMENT`), `RegistrationConfirmed` (`CONFIRMED`), `RegistrationCancelled` (`CANCELLED`), `RegistrationExpired` (`EXPIRED`), `RegistrationRejected` (`REJECTED`) | `registration_id`, `event_id`, `activity_id` | `user_id` |
| `subscription.events` | `AttendanceRecorded` (check-in) | `registration_id`, `event_id`, `activity_id` | `user_id` |
| `payments.events` | `PaymentCreated` (`PENDING`), `PaymentApproved` (`APPROVED`), `PaymentDeclined` (`DECLINED`), `PaymentExpired` (`EXPIRED`), `PaymentCancelled` (`CANCELLED`), `PaymentRefunded` (`REFUNDED`) | `payment_id`, `event_id` | `registration_id`, `activity_id`, `amount_minor`, `currency` |

O banco guarda só o último estado de cada inscrição e de cada pagamento.

Valores: pagamentos trazem `amount_minor`, um inteiro em centavos. O serviço o grava como está em `payments.amount_minor` (`bigint`), sem conversão decimal; valor negativo, fracionário, em texto ou fora da faixa de inteiros seguros invalida a mensagem. A coluna decimal antiga `amount` continua na tabela, sem uso. As migrações (idempotentes, executadas na inicialização) renomeiam os estados já gravados (`PENDING` para `PENDING_PAYMENT` nas inscrições; `CONFIRMED` para `APPROVED` e `REFUSED` para `DECLINED` nos pagamentos) e preenchem `amount_minor` a partir de `amount`.

As mensagens de inscrição e de check-in devem trazer `event_id`; sem ele, são inválidas (`event_id is required`).

Ignorados como qualquer tipo desconhecido: `AttendanceEligible`, `ActivityDeleted`, `ActivityEnded` e `ActivityCancelled`.

Exigências para os produtores:

- `EventCreated` deve trazer o `organizer_id`; sem ele, ninguém consegue ver os relatórios do evento.
- Todo evento deve trazer os identificadores completos (`event_id` e `activity_id`), porque o serviço não consulta ninguém.
- O `message_id` deve ser único por mensagem e estável no reenvio, pois é a chave de idempotência.
- Tipos desconhecidos são ignorados, e mensagens inválidas vão para a DLQ como referência e são puladas, sem travar a partição.

## 6. Interface: o que o serviço entrega

Todas as rotas exigem o cabeçalho `X-User-Id`, que deve ser um UUID. Pelo gateway, os endereços começam com `/reports`.

| Endpoint | Retorna |
| --- | --- |
| `GET /events` | Eventos do organizador que fez a chamada (paginado). |
| `GET /events/{eventId}/summary` | Tudo junto: evento, inscrições, pagamentos, ocupação e comparecimento. |
| `GET /events/{eventId}/activities` | Os mesmos indicadores, por atividade (paginado). |
| `GET /events/{eventId}/registrations` | Inscrições por estado: `pending_payment`, `offered`, `confirmed`, `waitlisted`, `cancelled`, `expired`, `rejected` e `total`. |
| `GET /events/{eventId}/payments` | Pagamentos por estado (`pending`, `approved`, `declined`, `expired`, `cancelled`, `refunded_count`) e as listas `revenue` e `refunded`, por moeda. |
| `GET /events/{eventId}/attendance` | Inscritos confirmados, check-ins e taxa de comparecimento. |

Dinheiro sai em centavos inteiros, por moeda: `"revenue": [{"currency": "BRL", "amount_minor": 2500}]` e `"refunded": [...]` no mesmo formato. Por atividade, a rota `/activities` traz os mesmos contadores de inscrição, `payments_approved`, `revenue` e `refunded`.

Mudança de API (incompatível): `pending` de inscrições virou `pending_payment` (`offered` e `rejected` são novos); `confirmed` e `refused` de pagamentos viraram `approved` e `declined`; a `revenue` numérica virou a lista por moeda; por atividade, `pending` virou `pending_payment` e `payments_confirmed` virou `payments_approved`.

Controle de acesso (RN07): o serviço compara o `X-User-Id` com o `organizer_id` guardado a partir do evento. Quem não é o dono recebe 404, igual a um evento inexistente (ou a um `eventId` que não é UUID, sem consultar o banco), e quem não se identifica, ou envia um `X-User-Id` que não é UUID, recebe 401. O `X-User-Roles` não é usado: a única regra é «dono do evento».

Erros: toda resposta de erro é `application/problem+json` com `{title, status, code, detail?, traceId}`. Códigos: `UNAUTHENTICATED` (401), `VALIDATION_ERROR` (400, por exemplo `limit` ou `offset` inválidos), `EVENT_NOT_FOUND` (404, evento inexistente, id que não é UUID ou evento de outro organizador), `NOT_FOUND` (404, rota desconhecida) e `INTERNAL_ERROR` (500, sem detalhes internos). Exemplo: `{"title":"Unauthorized","status":401,"code":"UNAUTHENTICATED","detail":"X-User-Id header is missing or not a UUID","traceId":"..."}`.

Trace id: o `X-Trace-Id` recebido só é mantido se casar com `^[A-Za-z0-9._-]{8,64}$`; caso contrário o serviço gera um UUID. O valor vai nos logs, no `traceId` dos erros e no cabeçalho `X-Trace-Id` de toda resposta. `X-Request-Id` e `X-Correlation-Id` são ignorados.

Paginação: `GET /events` e `GET /events/{eventId}/activities` aceitam `limit` (1 a 100, padrão 20) e `offset` (a partir de 0, padrão 0) e devolvem `{items, total, limit, offset}`; o formato de cada item não mudou. Mudança de API (incompatível): antes devolviam só `{items}`, com todos os itens; agora, sem parâmetros, vêm só os 20 primeiros.

Gateway: cada rota de consulta declara no OpenAPI a extensão `x-gateway` (`isPublic: true`, `requireAuth: true`, `rateLimitBy: user_or_ip`, `maxPerMin: 60`), lida pelo gateway ao criar o endpoint; não é mais preciso liberar as rotas à mão. `/healthcheck` e `/openapi.json` não declaram nada e continuam privadas. O OpenAPI também documenta o cabeçalho `X-User-Id` e as respostas de erro.

O serviço também expõe `GET /healthcheck` (503 até a primeira migração terminar e sempre que o ping no banco falha; 200 nos demais casos; corpo `{"status":"ok"}` ou `{"status":"unavailable"}`) e `GET /openapi.json`, que o gateway lê ao iniciar para conhecer as rotas.

## 7. Fluxos principais

**Processamento de uma mensagem**

1. O consumidor lê a mensagem e valida o envelope.
2. Numa única transação, grava o `message_id` em `processed_messages` e atualiza o estado da entidade.
3. Só então confirma o offset no Kafka. Se o banco falhar, a mensagem é reentregue e tratada de novo sem duplicar efeito.

**Mensagem repetida:** o `message_id` já existe, então a segunda cópia é ignorada e nenhum total muda.

**Mensagem atrasada:** cada linha guarda a data do último evento aplicado. Uma mensagem mais antiga (por exemplo, um cancelamento anterior a uma confirmação) é descartada e não desfaz o estado mais recente.

**Mensagem inválida** (vazia, JSON ilegível, contrato violado ou `schema_version` não suportada): é publicada na DLQ `reports.dlq` (`REPORTS_DLQ_TOPIC`, criada na inicialização como os demais tópicos) só como referência, `{"source_topic", "partition", "offset", "reason"}`, nunca o conteúdo, e o offset avança. Tipos desconhecidos ou ignorados não vão para a DLQ. Se a publicação na DLQ falhar, o offset não é confirmado e a mensagem é reentregue, para não perder a referência.

**Queda do consumidor:** se o kafkajs desistir do consumidor (evento `CRASH`), o serviço o reinicia com espera, em vez de ficar parado com o `/healthcheck` verde. O consumidor usa `metadataMaxAge` de 10 s para notar tópicos criados depois.

**Consulta de relatório:** o gateway repassa o `X-User-Id`; o serviço confere o dono do evento, soma os estados guardados e devolve o JSON.

## 8. Padrões de arquitetura aplicados

| Padrão | Como foi aplicado | Situação |
| --- | --- | --- |
| Database per service | PostgreSQL próprio, sem acesso de outros serviços | Implementado |
| API Gateway | Rotas liberadas por endpoint, com autenticação exigida, declaradas no OpenAPI com `x-gateway` | Implementado |
| Server-side discovery | Registro no discoverer pela biblioteca TypeScript compartilhada `discovery` (10 tentativas, de 1 s a 30 s) | Implementado |
| Messaging com consumidor idempotente | `message_id` gravado na mesma transação do efeito | Implementado |
| Health check API | `GET /healthcheck`: 503 até a primeira migração e quando o ping no banco falha | Implementado |
| Access token | Identidade por `X-User-Id` (UUID) repassado pelo gateway, sem verificação no serviço, como no resto do monorepo; autorização por dono do evento | Parcial |
| Exception tracking | Erros em `application/problem+json` com `code` e `traceId`; falhas inesperadas ficam no log (ferramenta externa não definida pelo time) | Parcial |
| Audit log | O serviço só lê dados, e não publica eventos de auditoria; formato e tópico não definidos pelo time | Pendente |

## 9. Atendimento aos requisitos

| Requisito | Atendimento |
| --- | --- |
| RF11 Relatórios | Indicadores de inscrições, pagamentos, ocupação e comparecimento para organizadores. |
| RN07 Segurança e acesso | O organizador só vê os eventos dele; os demais casos retornam 404. |
| RQ01 Evolução independente | Serviço isolado, com banco, contratos e implantação próprios. |
| RQ02 Escalabilidade seletiva | Pode ter réplicas e consome em grupo de consumidores; os indicadores são calculados por SQL agregado. |
| RQ03 Disponibilidade e resiliência | O serviço sobe sem Postgres, Kafka ou discoverer e tenta de novo em segundo plano; o consumidor é reiniciado se cair. O health check só olha a migração e o banco, então a queda do Kafka não o derruba. |
| RQ04 Consistência | Os dados são eventualmente consistentes com os serviços de origem; duplicidade e desordem não corrompem os totais. |
| RQ05 Interoperabilidade | Eventos JSON versionados e REST com OpenAPI. |
| RQ06 Observabilidade | Logs estruturados, `X-Trace-Id` (aceito só se bem formado) em toda resposta e no `traceId` dos erros, e `trace_id` de cada mensagem nos logs do consumidor. |
| RQ07 Segurança | Senha do banco por variável de ambiente (o valor de desenvolvimento no compose deve ser trocado fora do repositório). |
| RQ08 Operabilidade | Dockerfile, compose com o banco e README com o contrato de eventos e as instruções. |

## 10. Testes e validação

Testes unitários (todos passando): leitura e validação das mensagens, DLQ, cálculo das taxas, rotas (erros, identidade, trace id, paginação, `x-gateway`) com um banco simulado. Há também um teste de integração com PostgreSQL real (`npm run test:integration`, só roda com `TEST_DATABASE_URL`): ele confere a migração de linhas no formato antigo (e sua idempotência), projeta uma sequência realista de mensagens e verifica ocupação, contadores, receita por moeda, reembolsos e reentrega.

Validação com Postgres, Kafka e gateway reais, usando mensagens enviadas manualmente (evento `e1` do organizador `o1`, atividade com 2 vagas, 2 inscrições, 1 pagamento de 50 e 1 check-in):

| Teste | Resultado |
| --- | --- |
| Resumo do evento | 1 inscrição pendente e 1 confirmada; 1 pagamento confirmado com receita 50 (formatos anteriores à mudança de estados e de dinheiro); ocupação 2 de 2 (taxa 1); 1 check-in em 1 confirmado (taxa 1). |
| Mensagem repetida | O reenvio foi registrado como `duplicate` e a receita continuou em 50. |
| Mensagem fora de ordem | Um cancelamento mais antigo que a confirmação não alterou o estado. |
| Autorização | Usuário que não é o organizador recebeu 404; sem `X-User-Id`, 401. |
| Listagem e atividades | `/events` listou o evento, e `/activities` mostrou os números por atividade. |

Ainda falta registrar o teste de resiliência (consultar o relatório com o Kafka parado e confirmar que o consumidor reconecta sozinho), além de uma verificação isolada do endpoint `/attendance`.

## 11. Limitações e próximos passos

- Os três serviços já publicam nos tópicos `events.events`, `subscription.events` e `payments.events`; o serviço de relatórios foi adaptado a esses nomes e formatos, mas ainda não foi validado com Kafka e PostgreSQL reais depois da mudança (a validação da seção 10 usou o contrato antigo).
- A tabela `processed_messages` cresce sem limpeza.
- Não há filtro por período; a paginação existe só nas duas listas (`/events` e `/activities`).
- O gateway envia o papel em `X-User-Roles`, mas o serviço não o usa: a única regra de acesso é «dono do evento», sem perfil de administrador.
- Tipos de evento sem tratamento: `ActivityDeleted`, `ActivityEnded` e `ActivityCancelled` (ver «Pendências conhecidas»).
- Os tópicos são criados com fator de replicação 1 e a `DATABASE_URL` tem uma senha de desenvolvimento por padrão (o compose a monta a partir de `REPORTS_DB_PASSWORD`); ambos servem para o ambiente local, mas não para produção.
- Ferramenta externa de exception tracking e audit log dependem de decisão do grupo.
- O teste de integração cobre o banco, mas não o broker Kafka.

### Pendências conhecidas

O que ainda NÃO foi feito (decisões de projeto a discutir):

- Check-ins continuam contando mesmo se a inscrição for cancelada depois.
- Tratamento de `ActivityDeleted`, `ActivityEnded` e `ActivityCancelled`.
- `AttendanceEligible`.
- A tabela `processed_messages` não tem retenção.

## 12. Dependências com os outros serviços

1. O serviço de eventos publica `Event*` e `Activity*` em `events.events`, com `organizer_id` no evento criado e `capacity` nas atividades (atendido).
2. O serviço de inscrições publica `Registration*`, `WaitlistOffered` e `AttendanceRecorded` em `subscription.events`, com `event_id`, que o relatório exige (em ajuste no serviço de inscrições).
3. O serviço de pagamentos publica `Payment*` (inclusive `PaymentRefunded`) em `payments.events` com `amount_minor` em centavos, que o relatório guarda como inteiro (atendido).
4. O gateway lê o `x-gateway` das seis rotas de consulta ao criar os endpoints (atendido pelo próprio serviço). Endpoints que o gateway já tinha criado como privados antes dessa declaração não são alterados (inserção apenas): é preciso liberá-los pela API de administração ou apagá-los do `gateway-db` para o gateway recriá-los.

## 13. Como executar

```
docker compose -f gateway/docker-compose.yml up -d
docker compose up --build kafka service-discoverer gateway reports reports-db
```

Testes unitários: `npm install` e `npm test` dentro da pasta `reports/`. Teste de integração: `TEST_DATABASE_URL=postgres://... npm run test:integration` (use um banco descartável: as tabelas são recriadas). Variáveis de ambiente, o contrato completo de eventos e a declaração `x-gateway` estão no `README.md` do serviço.
