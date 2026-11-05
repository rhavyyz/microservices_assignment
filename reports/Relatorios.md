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
| Kafka | Fonte única de dados: o serviço consome os tópicos `events-events`, `subscription-events` e `payments-events`. Ele não publica nada. |
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

- **Vagas ocupadas:** inscrições `PENDING` e `CONFIRMED` (uma reserva pendente já segura a vaga, RN02).
- **Taxa de ocupação:** vagas ocupadas dividido pela soma das capacidades das atividades.
- **Comparecimento:** check-ins dividido pelas inscrições confirmadas.
- **Receita:** soma dos pagamentos `CONFIRMED`.
- Quando o denominador é zero (por exemplo, capacidade zero), a taxa aparece vazia (`null`), e não zero.

## 5. Interface: o que o serviço recebe

O serviço não recebe chamadas de outros serviços. Recebe eventos pelo Kafka, em três tópicos (um por serviço de origem), em envelope versionado: `message_id`, `type`, `version` (1), `occurred_at`, `trace_id` e `data`.

| Tópico | Tipo de evento | Dados obrigatórios | Dados opcionais |
| --- | --- | --- | --- |
| `events-events` | `event.created`, `event.updated` | `event_id` | `organizer_id`, `name`, `status`, `starts_at`, `ends_at` |
| `events-events` | `event.published`, `event.cancelled` | `event_id` | os mesmos (o status é forçado para `PUBLISHED` ou `CANCELLED`) |
| `events-events` | `activity.created`, `activity.updated` | `activity_id`, `event_id` | `name`, `capacity`, `paid` |
| `subscription-events` | `registration.requested`, `confirmed`, `waitlisted`, `cancelled`, `expired` | `registration_id`, `event_id`, `activity_id` | `user_id` |
| `subscription-events` | `checkin.registered` | `registration_id`, `event_id`, `activity_id` | `user_id` |
| `payments-events` | `payment.created`, `confirmed`, `refused`, `expired`, `cancelled` | `payment_id`, `event_id` | `registration_id`, `activity_id`, `amount`, `currency` |

Exigências para os produtores:

- `event.created` deve trazer o `organizer_id`; sem ele, ninguém consegue ver os relatórios do evento.
- Todo evento deve trazer os identificadores completos (`event_id` e `activity_id`), porque o serviço não consulta ninguém.
- O `message_id` deve ser único por mensagem e estável no reenvio, pois é a chave de idempotência.
- Tipos desconhecidos são ignorados, e mensagens inválidas são registradas em log e puladas, sem travar a partição.

## 6. Interface: o que o serviço entrega

Todas as rotas exigem o cabeçalho `X-User-Id`. Pelo gateway, os endereços começam com `/reports`.

| Endpoint | Retorna |
| --- | --- |
| `GET /events` | Eventos do organizador que fez a chamada. |
| `GET /events/{eventId}/summary` | Tudo junto: evento, inscrições, pagamentos, ocupação e comparecimento. |
| `GET /events/{eventId}/activities` | Os mesmos indicadores, por atividade. |
| `GET /events/{eventId}/registrations` | Inscrições por estado: pendentes, confirmadas, em espera, canceladas, expiradas e total. |
| `GET /events/{eventId}/payments` | Pagamentos por estado e receita. |
| `GET /events/{eventId}/attendance` | Inscritos confirmados, check-ins e taxa de comparecimento. |

Controle de acesso (RN07): o serviço compara o `X-User-Id` com o `organizer_id` guardado a partir do evento. Quem não é o dono recebe 404, igual a um evento inexistente, e quem não se identifica recebe 401.

O serviço também expõe `GET /healthcheck` (200 só se o banco responde, senão 503) e `GET /openapi.json`, que o gateway lê ao iniciar para conhecer as rotas.

## 7. Fluxos principais

**Processamento de uma mensagem**

1. O consumidor lê a mensagem e valida o envelope.
2. Numa única transação, grava o `message_id` em `processed_messages` e atualiza o estado da entidade.
3. Só então confirma o offset no Kafka. Se o banco falhar, a mensagem é reentregue e tratada de novo sem duplicar efeito.

**Mensagem repetida:** o `message_id` já existe, então a segunda cópia é ignorada e nenhum total muda.

**Mensagem atrasada:** cada linha guarda a data do último evento aplicado. Uma mensagem mais antiga (por exemplo, um cancelamento anterior a uma confirmação) é descartada e não desfaz o estado mais recente.

**Mensagem inválida:** é registrada em log com tópico, partição e motivo, e pulada.

**Consulta de relatório:** o gateway repassa o `X-User-Id`; o serviço confere o dono do evento, soma os estados guardados e devolve o JSON.

## 8. Padrões de arquitetura aplicados

| Padrão | Como foi aplicado | Situação |
| --- | --- | --- |
| Database per service | PostgreSQL próprio, sem acesso de outros serviços | Implementado |
| API Gateway | Rotas liberadas por endpoint, com autenticação exigida | Implementado (liberação por script de administrador) |
| Server-side discovery | Registro no discoverer pela biblioteca TypeScript compartilhada `discovery` (10 tentativas, de 1 s a 30 s) | Implementado |
| Messaging com consumidor idempotente | `message_id` gravado na mesma transação do efeito | Implementado |
| Health check API | `GET /healthcheck` com ping no banco | Implementado |
| Access token | Identidade por `X-User-Id` repassado pelo gateway, sem verificação, como no resto do monorepo; autorização por dono do evento | Parcial |
| Exception tracking | Erros ficam registrados em log; ferramenta não definida pelo time | Pendente |
| Audit log | O serviço só lê dados, e não publica eventos de auditoria; formato e tópico não definidos pelo time | Pendente |

## 9. Atendimento aos requisitos

| Requisito | Atendimento |
| --- | --- |
| RF11 Relatórios | Indicadores de inscrições, pagamentos, ocupação e comparecimento para organizadores. |
| RN07 Segurança e acesso | O organizador só vê os eventos dele; os demais casos retornam 404. |
| RQ01 Evolução independente | Serviço isolado, com banco, contratos e implantação próprios. |
| RQ02 Escalabilidade seletiva | Pode ter réplicas e consome em grupo de consumidores; os indicadores são calculados por SQL agregado. |
| RQ03 Disponibilidade e resiliência | O serviço sobe sem Postgres, Kafka ou discoverer e tenta de novo em segundo plano. O health check só olha o banco, então a queda do Kafka não o derruba. |
| RQ04 Consistência | Os dados são eventualmente consistentes com os serviços de origem; duplicidade e desordem não corrompem os totais. |
| RQ05 Interoperabilidade | Eventos JSON versionados e REST com OpenAPI. |
| RQ06 Observabilidade | Logs estruturados, cabeçalho `X-Trace-Id` nas respostas e `trace_id` de cada mensagem nos logs do consumidor. |
| RQ07 Segurança | Senha do banco por variável de ambiente (o valor de desenvolvimento no compose deve ser trocado fora do repositório). |
| RQ08 Operabilidade | Dockerfile, compose com o banco e README com o contrato de eventos e as instruções. |

## 10. Testes e validação

Testes unitários (todos passando): leitura e validação das mensagens e cálculo das taxas.

Validação com Postgres, Kafka e gateway reais, usando mensagens enviadas manualmente (evento `e1` do organizador `o1`, atividade com 2 vagas, 2 inscrições, 1 pagamento de 50 e 1 check-in):

| Teste | Resultado |
| --- | --- |
| Resumo do evento | 1 inscrição pendente e 1 confirmada; 1 pagamento confirmado com receita 50; ocupação 2 de 2 (taxa 1); 1 check-in em 1 confirmado (taxa 1). |
| Mensagem repetida | O reenvio foi registrado como `duplicate` e a receita continuou em 50. |
| Mensagem fora de ordem | Um cancelamento mais antigo que a confirmação não alterou o estado. |
| Autorização | Usuário que não é o organizador recebeu 404; sem `X-User-Id`, 401. |
| Listagem e atividades | `/events` listou o evento, e `/activities` mostrou os números por atividade. |

Ainda falta registrar o teste de resiliência (consultar o relatório com o Kafka parado e confirmar que o consumidor reconecta sozinho), além de uma verificação isolada do endpoint `/attendance`.

## 11. Limitações e próximos passos

- Nenhum outro serviço publica ainda nos três tópicos: os testes usaram mensagens enviadas à mão, e os nomes e campos do contrato são uma proposta que o time precisa aceitar.
- A tabela `processed_messages` cresce sem limpeza.
- A receita soma valores de moedas diferentes sem separar por moeda.
- Não há paginação nem filtro por período.
- O gateway não repassa papel (role); a única regra de acesso é «dono do evento», sem perfil de administrador.
- Tipos de evento sem tratamento: cancelamento ou exclusão de atividade e exclusão de evento.
- Os tópicos são criados com fator de replicação 1 e o consumidor usa uma senha de desenvolvimento por padrão; ambos servem para o ambiente local, mas não para produção.
- Exception tracking e audit log dependem de decisão do grupo.
- Falta teste automatizado de integração com banco e broker.

## 12. Dependências com os outros serviços

1. O serviço de eventos precisa publicar `event.*` e `activity.*` em `events-events`, com `organizer_id` no evento criado e `capacity` nas atividades.
2. O serviço de inscrições precisa publicar `registration.*` e `checkin.registered` em `subscription-events`, com `event_id` e `activity_id`.
3. O serviço de pagamentos publica `payment.*` em `payments-events` no formato que o relatório já consome.
4. O administrador do gateway precisa liberar as seis rotas de consulta com autenticação exigida.

## 13. Como executar

```
docker compose -f gateway/docker-compose.yml up -d
docker compose up --build kafka service-discoverer gateway reports reports-db
```

Testes unitários: `npm install` e `npm test` dentro da pasta `reports/`. Variáveis de ambiente, o contrato completo de eventos e o script de liberação das rotas estão no `README.md` do serviço.
