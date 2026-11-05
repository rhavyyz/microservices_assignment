# Serviço de Inscrições — Python

Inscrições é dono de **toda ocupação de vagas**, participantes, reservas, fila e presença.
Eventos fornece apenas a capacidade máxima imutável e os dados da atividade. Não existe
incremento/decremento de participantes em Eventos e nenhum outro banco é acessado.

Implementação: Python 3.13, FastAPI, psycopg/PostgreSQL e confluent-kafka. Comentários e
docstrings explicam as decisões e invariantes. As integrações HTTP/Kafka propostas estão
em [CONTRACTS.md](CONTRACTS.md); Eventos e Pagamentos ainda são placeholders no monorepo.

## Organização

| Arquivo | Responsabilidade |
|---|---|
| `app/api.py` | Rotas, autenticação, autorização por recurso, erros e correlação |
| `app/service.py` | Casos de uso, estados e transações locais |
| `app/contracts.py` | Validação estrita das respostas e eventos externos |
| `app/security.py` | Identidade pelos cabeçalhos `X-User-Id`/`X-User-Roles` do gateway |
| `app/integrations.py` | HTTP com timeout e protocolo do discoverer |
| `app/workers.py` | Expiração, outbox, consumo Kafka e registro |
| `app/db.py` e `app/migrations/` | Pool, transações e migrações versionadas |
| `tests/` | Concorrência em PostgreSQL real, API, identidade por cabeçalhos e falhas de mensageria |

## Regras implementadas

- Toda escrita que afeta ocupação bloqueia primeiro `activity_inventory` com `FOR UPDATE`.
  A criação do registro de controle é idempotente. Réplicas coordenam pelo banco.
- Contadores, inscrição e mensagens da outbox são confirmados juntos. Constraints impõem
  `reserved + confirmed <= capacity`, não negatividade e uma inscrição ativa por pessoa/atividade.
- Capacidade é copiada da API confiável de Eventos. Um trigger proíbe sua alteração.
- Atividade gratuita confirma imediatamente; paga reserva (`PENDING_PAYMENT`) e emite `RegistrationPendingPayment` (Pagamentos o ignora: a cobrança é criada por `POST /payments`).
  O valor/moeda são fotografados na inscrição e preservados inclusive durante a fila.
- A inscrição é idempotente por pessoa e atividade: repeti-la devolve a inscrição existente
  com 200 (sem consultar Eventos); uma nova é 201. Após cancelar ou expirar, nova inscrição é permitida.
- Estados: `WAITLISTED`, `OFFERED`, `PENDING_PAYMENT`, `CONFIRMED`, `CANCELLED`, `EXPIRED`, `REJECTED`.
  `OFFERED` e `PENDING_PAYMENT` ocupam reserva; `WAITLISTED` não ocupa vaga.
- Fila FIFO por sequência no banco. Liberação e promoção ocorrem sob o mesmo lock,
  impedindo que uma inscrição nova passe na frente. Oferta possui reserva e prazo.
- Expiração usa relógio do banco após aquisição do lock. Pagamento recebido após vencimento
  não confirma, mesmo que tenha ocorrido anteriormente no provedor: é ignorado e Pagamentos estorna.
- Cancelamento libera a vaga imediatamente em transação local. Inscrições é declarativa: não
  envia comandos nem chama Pagamentos; cancelamento/expiração são só eventos de domínio e
  Pagamentos cancela ou estorna por conta própria. O prazo da reserva é a autoridade sobre a vaga.
- `PaymentApproved` confirma só uma inscrição `PENDING_PAYMENT` dentro do prazo e com o mesmo
  valor/moeda; `PaymentDeclined` rejeita e promove a fila; os demais resultados são informativos.
- Check-in exige inscrição confirmada, período da atividade e organizador responsável.
  Critério de presença (RN06): o certificado é por **evento**, não por atividade. Percentual =
  atividades do evento com inscrição `CONFIRMED` **e** check-in ÷ atividades do evento com inscrição
  `CONFIRMED`. Inscrições em fila, expiradas, canceladas ou rejeitadas e atividades canceladas não
  entram na conta. Com percentual >= `ATTENDANCE_MIN_PERCENT` (padrão 75, número em (0, 100]),
  emite **um** `AttendanceEligible` por pessoa e evento, quando a última atividade confirmada da
  pessoa nesse evento encerra (`ActivityEnded`) ou é cancelada (`ActivityCancelled`: a cancelada sai da conta e quem
  estava confirmada nela é reavaliada; sem nenhuma atividade restante, nada é emitido). Abaixo do mínimo, nada é emitido. A tabela
  `event_attendance_emitted` garante a unicidade; a primeira conclusão vence (inscrição confirmada
  depois da emissão, em outra atividade do mesmo evento, não gera nova emissão). Atividades
  encerradas antes da migração 003 não são reavaliadas (sem backfill). Não emite certificados.
- `ActivityCancelled` cancela inscritos e fila, libera vagas e solicita compensações.
  Cancelamento voluntário após `ActivityEnded` é rejeitado.

## Execução com o monorepo

O compose raiz inclui o banco privado (`subscription-db`) e já declara a configuração do
contêiner de aplicação, sem necessidade de arquivos adicionais.

1. Defina `SUBSCRIPTION_DB_PASSWORD` no `.env` da raiz (veja o `.env.example` da raiz). Sem ela o
   `subscription-db` não inicia. A URL do banco é montada a partir da senha; se ela tiver caracteres
   reservados de URL, use percent-encoding e defina `SUBSCRIPTION_DATABASE_URL` explicitamente.
2. Inicie o projeto separado de MongoDB do gateway, conforme README da raiz.
3. Da raiz, execute:

```sh
docker compose -f gateway/docker-compose.yml up -d
docker compose up --build
```

Não versionar segredos.
O gateway deve sincronizar `/openapi.json` depois de Inscrições estar registrado; se já
estava rodando com outra especificação, reinicie-o para refazer essa sincronização.

As rotas nascem privadas no gateway. Para abri-las explicitamente:

```sh
python subscription/scripts/register_gateway.py --gateway http://localhost:8080
```

O gateway verifica o JWT (`requireAuth=true`) e injeta `X-User-Id` (UUID do `sub`) e `X-User-Roles`
(separados por vírgula); Inscrições **não valida JWT**: a identidade vem somente desses cabeçalhos,
nunca do corpo. Sem `X-User-Id` válido a resposta é 401 `UNAUTHENTICATED`. Nas chamadas a Eventos em nome do usuário, o serviço repassa `X-User-Id`, `X-User-Roles`, `X-Request-Id` e o `Authorization` (sem verificá-lo); chamadas de fundo (Kafka) não levam identidade.
O Gateway é a única porta publicada; os serviços internos não têm porta no host e confiam nos cabeçalhos `X-User-Id`/`X-User-Roles` que somente o Gateway define (ele descarta os enviados pelo cliente). `/healthcheck` e `/openapi.json`
não são publicados pelo script. A execução do script altera apenas os registros dessas rotas.

## Desenvolvimento local

```sh
python -m venv .venv
# Ative o ambiente conforme seu shell.
python -m pip install -r requirements.lock
python -m pip install -e '.[test]'
# Configure SUBSCRIPTION_DATABASE_URL, URL de descoberta e Kafka acessíveis localmente.
python -m app
```

`WORKERS_ENABLED=false` permite testar só HTTP, mas desliga também expiração e entrega de
mensagens: não usar assim para executar o fluxo completo. O banco é obrigatório na inicialização;
migrações usam lock para não correrem simultaneamente em várias réplicas. Falha no Kafka ou
discoverer não impede a API de iniciar. `/healthcheck` verifica o banco, não esses serviços.

Também existe `python -m app migrate`. Não há criação de tabelas por ORM: alterações futuras
devem adicionar uma nova migração SQL, sem editar migração já aplicada.

## API

Prefixo pelo gateway: `/subscription`. Exemplos abaixo são caminhos internos.

| Método | Rota | Acesso |
|---|---|---|
| POST | `/api/v1/activities/{id}/registrations` | Participante autenticado; 201 se nova, 200 se já existe inscrição viva; corpo `{"join_waitlist": true}` |
| GET | `/api/v1/activities/{id}/availability` | Autenticado; disponibilidade informativa, não concede vaga |
| GET | `/api/v1/registrations/me` | Próprias inscrições |
| GET | `/api/v1/registrations/{id}` | Proprietário; inclui estado financeiro |
| POST | `/api/v1/registrations/{id}/cancel` | Proprietário; repetição não libera duas vezes |
| POST | `/api/v1/registrations/{id}/accept-offer` | Proprietário; repetição não cria cobrança duplicada |
| GET | `/api/v1/activities/{id}/registrations` | Organizador responsável |
| POST | `/api/v1/registrations/{id}/check-in` | Organizador responsável |

Listas têm `limit` (1–100, padrão 50) e `offset` (>=0). IDs são UUIDs. Campos não reconhecidos
na criação são rejeitados; o cliente não informa usuário, preço, capacidade ou estado.
Erros de negócio usam `application/problem+json` com `code` e `traceId`.
Validação de formato da API usa 422 do FastAPI. Falha de dependência retorna 503;
recurso alheio retorna 404, acesso administrativo negado retorna 403.

## Mensageria e recuperação

Na inicialização, em segundo plano (a API nunca depende do Kafka para subir), o serviço cria, se
ausentes, todos os tópicos que usa — `payments.events`, `events.events`,
`subscription.events`, `notifications` e `subscription.dlq` — com `SUBSCRIPTION_TOPIC_PARTITIONS`
partições (padrão 6). Tópicos existentes nunca são alterados. Se o Kafka estiver fora, a criação é
repetida com espera crescente (2 s a 30 s); publicador e consumer só iniciam depois dela. O consumer
verifica novos tópicos a cada 10 s.

O consumer confirma offsets apenas depois do commit. Erros transitórios recriam o consumer,
retomando do offset confirmado. Mensagens inválidas são referenciadas em uma DLQ via outbox;
não se copiam dados pessoais para logs/DLQ. A DLQ requer operação humana: corrigir e republicar
a mensagem original, respeitando seu contrato. Falha de negócio desfeita não grava a inbox.

Outbox possui entrega **pelo menos uma vez**. Um publicador por banco é eleito por advisory
lock de sessão, preservando ordem de publicação e sem manter transação de negócio durante
a rede. Isso privilegia simplicidade: uma falha no primeiro registro impede avanço da fila
até recuperar. A confirmação já persistida nunca é desfeita por falha de notificação.

Notificações atual deduplica por offset, não por evento de negócio; republicação da outbox
pode produzir duas notificações. O `payload.message_id` é estável, mas deduplicá-lo exigiria
alteração naquele serviço, deliberadamente fora deste trabalho.

Não há reconciliação financeira nem tabela de tentativas de pagamento (migração `004`): Pagamentos lê
os fatos de uma inscrição em `GET /internal/registrations/{id}` (rota interna, sem autenticação, fora do
OpenAPI e do gateway) e decide sozinho cobrança, expiração e estorno.
Inbox, histórico e outbox não têm limpeza automática nesta versão, evitando apagar evidências
necessárias à deduplicação. Defina retenção operacional antes de uso prolongado.

## Testes

Use exclusivamente um banco de testes. A suite cria e remove schemas UUID nesse banco;
não altera tabelas de outros schemas. Sem `TEST_DATABASE_URL`, testes de banco são marcados
como skipped; isso não comprova concorrência.

```sh
# Exemplo de URL; a conta precisa poder criar schemas no banco informado.
export TEST_DATABASE_URL='postgresql://user:password@localhost:5432/subscription_test'
python -m pytest -q
ruff check app tests scripts
```

Em PowerShell, configure com `$env:TEST_DATABASE_URL='...'`.
Resultados reais desta entrega estão em [VALIDATION.md](VALIDATION.md).
