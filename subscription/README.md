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
| `app/security.py` | JWT RS256, issuer, expiração e sujeito UUID |
| `app/integrations.py` | HTTP com timeout e protocolo do discoverer |
| `app/workers.py` | Expiração, outbox, consumo Kafka, reconciliação e registro |
| `app/db.py` e `app/migrations/` | Pool, transações e migrações versionadas |
| `tests/` | Concorrência em PostgreSQL real, API, JWT e falhas de mensageria |

## Regras implementadas

- Toda escrita que afeta ocupação bloqueia primeiro `activity_inventory` com `FOR UPDATE`.
  A criação do registro de controle é idempotente. Réplicas coordenam pelo banco.
- Contadores, inscrição e mensagens da outbox são confirmados juntos. Constraints impõem
  `reserved + confirmed <= capacity`, não negatividade e uma inscrição ativa por pessoa/atividade.
- Capacidade é copiada da API confiável de Eventos. Um trigger proíbe sua alteração.
- Atividade gratuita confirma imediatamente; paga reserva e solicita cobrança assíncrona.
  O valor/moeda são fotografados na inscrição e preservados inclusive durante a fila.
- `Idempotency-Key` é obrigatório na criação, escopado ao usuário e validado contra o pedido.
  Uma repetição devolve a resposta original; consultar o GET para o estado atual.
- Estados: `WAITLISTED`, `OFFERED`, `PENDING_PAYMENT`, `CONFIRMED`, `CANCELLED`, `EXPIRED`, `REJECTED`.
  `OFFERED` e `PENDING_PAYMENT` ocupam reserva; `WAITLISTED` não ocupa vaga.
- Fila FIFO por sequência no banco. Liberação e promoção ocorrem sob o mesmo lock,
  impedindo que uma inscrição nova passe na frente. Oferta possui reserva e prazo.
- Expiração usa relógio do banco após aquisição do lock. Pagamento recebido após vencimento
  não confirma, mesmo que tenha ocorrido anteriormente no provedor: solicita estorno.
- Cancelamento libera a vaga imediatamente em transação local. Compensação financeira
  é assíncrona e seu estado aparece separadamente em `payment.status` no GET individual.
- Pagamento aprovado após cancelamento/expiração gera `PaymentRefundRequested`.
  Cancelamento de tentativa ainda pendente gera `PaymentCancelRequested`.
- Check-in exige inscrição confirmada, período da atividade e organizador responsável.
  Critério de presença adotado nesta versão: **um check-in válido**. Após `ActivityEnded`,
  emite `AttendanceEligible` apenas para confirmados presentes. Não emite certificados.
- `ActivityCancelled` cancela inscritos e fila, libera vagas e solicita compensações.
  Cancelamento voluntário após `ActivityEnded` é rejeitado.

## Execução com o monorepo

Nenhum arquivo fora desta pasta precisa ser editado. O compose raiz inclui o banco privado;
o overlay nesta pasta injeta configuração no contêiner de aplicação já declarado na raiz.

1. Defina as variáveis exemplificadas em `.env.example` no ambiente ou em um arquivo local.
   Senha e URL devem corresponder; use percent-encoding para caracteres especiais na URL.
2. Inicie o projeto separado de MongoDB do gateway, conforme README da raiz.
3. Da raiz, execute:

```sh
docker compose -f gateway/docker-compose.yml up -d
docker compose --env-file subscription/.env -f docker-compose.yml -f subscription/compose.integration.yml up --build
```

O arquivo `subscription/.env` também deve incluir as configurações dos demais serviços
exigidas pelo compose raiz, ou elas devem estar no ambiente. Não versionar segredos.
O gateway deve sincronizar `/openapi.json` depois de Inscrições estar registrado; se já
estava rodando com outra especificação, reinicie-o para refazer essa sincronização.

As rotas nascem privadas no gateway. Para abri-las explicitamente:

```sh
python subscription/scripts/register_gateway.py --gateway http://localhost:8080
```

`requireAuth=false` no gateway é intencional: ele só verifica a presença de `X-User-Id`.
**Todas as rotas de negócio de Inscrições exigem JWT válido**, independentemente desse header.
`rateLimitBy=ip` evita confiar no identificador não verificado. `/healthcheck` e `/openapi.json`
não são publicados pelo script. A execução do script altera apenas os registros dessas rotas.

## Desenvolvimento local

```sh
python -m venv .venv
# Ative o ambiente conforme seu shell.
python -m pip install -r requirements.lock
python -m pip install -e '.[test]'
# Configure SUBSCRIPTION_DATABASE_URL, URLs de descoberta/JWKS e Kafka acessíveis localmente.
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
| POST | `/api/v1/activities/{id}/registrations` | Participante autenticado; `Idempotency-Key`; corpo `{"join_waitlist": true}` |
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

O consumer confirma offsets apenas depois do commit. Erros transitórios recriam o consumer,
retomando do offset confirmado. Mensagens inválidas são referenciadas em uma DLQ via outbox;
não se copiam dados pessoais para logs/DLQ. A DLQ requer operação humana: corrigir e republicar
a mensagem original, respeitando seu contrato. Falha de negócio desfeita não grava a inbox.

Outbox possui entrega **pelo menos uma vez**. Um publicador por banco é eleito por advisory
lock de sessão, preservando ordem de publicação e sem manter transação de negócio durante
a rede. Isso privilegia simplicidade: uma falha no primeiro registro impede avanço da fila
até recuperar. A confirmação já persistida nunca é desfeita por falha de notificação.

Notificações atual deduplica por offset, não por evento de negócio; republicação da outbox
pode produzir duas notificações. O `payload.event_id` é estável, mas deduplicá-lo exigiria
alteração naquele serviço, deliberadamente fora deste trabalho.

Reconciliação consulta snapshots de tentativas financeiras pendentes e repete compensações
com chave estável. Snapshot inexistente/serviço indisponível não é interpretado como recusa.
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
