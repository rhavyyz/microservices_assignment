# Como executar, testar e demonstrar o EventHub

Passo a passo único para subir a pilha inteira, criar dados de demonstração e rodar todos os testes. Os detalhes de cada serviço estão nos READMEs
das pastas.

## 1. Pré-requisitos

| Ferramenta | Para quê |
|---|---|
| Docker com Compose v2 | subir a pilha e os testes de integração (`*IT`) |
| Node `^22.22.2`, `^24.15.0` ou `>=26` | frontend (testes com jsdom 30) e serviços Node (Eventos, Pagamentos, Relatórios) |
| JDK 21 | serviço de Usuários (`./mvnw`) |
| Python 3.13 (Inscrições) e 3.12 (Certificados) | versões das imagens Docker |
| Go 1.24 | Gateway, Notificações e service-discoverer |
| `curl` e `python3` | `scripts/demo-seed.sh` |

## 2. Subir a pilha

Na raiz do repositório:

```bash
cp .env.example .env                  # troque as senhas fictícias (USERS_DB_PASSWORD e SUBSCRIPTION_DB_PASSWORD são obrigatórias)
user/scripts/gen-dev-keys.sh          # chave RSA de desenvolvimento em user/.keys (ignorada pelo git)
# para ter um administrador, no .env:
#   USERS_ADMIN_BOOTSTRAP_ENABLED=true
#   USERS_ADMIN_BOOTSTRAP_EMAIL=admin@example.test
#   USERS_ADMIN_BOOTSTRAP_PASSWORD=<senha forte>
docker compose -f gateway/docker-compose.yml up -d     # banco do Gateway (cria a rede gateway-net). Sempre primeiro
docker compose --env-file .env up --build -d           # todos os serviços
```

Depois de alguns instantes o Gateway responde em `http://localhost:8080`. Conferências rápidas:

```bash
docker compose ps                                   # todos "healthy" ou "running"
curl -s localhost:8080/docs -o /dev/null -w '%{http_code}\n'   # 200: Swagger UI unificado do Gateway
curl -s localhost:8080/events/api/v1/events         # lista pública (vazia na primeira vez)
curl -s localhost:8080/admin/endpoints | tr '{' '\n' | grep -c .   # rotas aprendidas pelo Gateway
```

Se o Gateway já tinha um banco antigo, as rotas novas nascem privadas e respondem `404`. Reinicie com banco limpo (apaga só os dados do Gateway):

```bash
docker compose --env-file .env down
docker compose -f gateway/docker-compose.yml down -v
docker compose -f gateway/docker-compose.yml up -d && docker compose --env-file .env up -d
```

Parar tudo: `docker compose --env-file .env down` e depois `docker compose -f gateway/docker-compose.yml down`.

## 3. Dados de demonstração

```bash
ADMIN_PASSWORD='<a mesma do .env>' scripts/demo-seed.sh
```

O script usa só o Gateway e percorre o fluxo da seção 5 do relatório: cadastra um participante e um candidato a organizador, o administrador aprova
o pedido, o organizador cria e publica um evento com uma atividade paga (2 vagas, lista de espera) e uma gratuita, e o participante se inscreve,
paga no provedor simulado e vê a inscrição ficar `CONFIRMED`. No fim ele imprime os ids e as contas.

Variáveis opcionais: `GATEWAY` (padrão `http://localhost:8080`), `ADMIN_EMAIL`, `DEMO_PASSWORD`, `ORG_EMAIL`, `PART_EMAIL`, `DEMO_YEAR`.

Contas criadas (senha `Demo#Senha2026`, a menos que `DEMO_PASSWORD` mude): `participante.demo@example.test`, `organizador.demo@example.test`.
Existe também o seed opcional de um organizador pronto (`USERS_DEV_SEED_*` no `.env.example`), desativado por padrão.

### Cenários alternativos à mão

Com uma segunda conta inscrita na atividade paga, no mesmo caminho do script:

| Cenário | O que fazer | Resultado esperado |
|---|---|---|
| Pagamento recusado | `POST /payments/payments/{id}/simulate` com `{"action":"decline"}` | inscrição `REJECTED`, vaga liberada, primeiro da fila `OFFERED` |
| Expiração | `{"action":"expire"}` ou esperar `RESERVATION_SECONDS` (900 s) | pagamento `EXPIRED` e, ao vencer a reserva, inscrição `EXPIRED` |
| Overbooking | com 2 vagas, inscrever 3 contas ao mesmo tempo | só 2 reservas, a terceira cai na fila ou recebe erro de lotação |
| Eventos fora | `docker compose stop events` e tentar se inscrever | `503 DEPENDENCY_UNAVAILABLE`, sem reserva |
| Kafka fora | `docker compose stop kafka`, inscrever, `start kafka` | resposta normal e eventos publicados depois pela outbox |

## 4. Frontend

```bash
cd frontend && cp .env.example .env && npm ci && npm run dev    # http://localhost:5173 (VITE_API_BASE_URL aponta para o Gateway)
```

## 5. Testes

| Serviço | Comando | Observação |
|---|---|---|
| Frontend | `cd frontend && npm run lint && npm run typecheck && npm run test:run && npm run build` | sem Docker |
| Usuários | `(cd service-discoverer/Libs/java && mvn -q install -DskipTests) && cd user && ./mvnw verify` | `*IT` precisam de Docker |
| Eventos, Pagamentos, Relatórios | `cd <serviço> && npm ci && npm test` | `node:test` |
| Inscrições | `cd subscription && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.lock ../service-discoverer/Libs/python "httpx>=0.28,<1" pytest ruff && TEST_DATABASE_URL=postgresql://postgres:test@localhost:55432/subscription_test python -m pytest -v && ruff check app tests scripts` | precisa de um PostgreSQL de teste (`docker run -d --name pgtest -e POSTGRES_PASSWORD=test -e POSTGRES_DB=subscription_test -p 55432:5432 postgres:16`). Sem `TEST_DATABASE_URL` os testes de concorrência são ignorados |
| Certificados | `cd certificates && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt ../service-discoverer/Libs/python pytest && PYTHONPATH=$PWD python -m pytest` | |
| Gateway, Notificações, service-discoverer | `cd <pasta> && go test ./...` | |

## 6. Documentação das APIs

| O quê | Onde |
|---|---|
| Todas as rotas públicas, com `x-gateway` | `http://localhost:8080/docs` (Swagger UI) e `/openapi.json` |
| Usuários (OpenAPI escrito) | `docs/api/users.openapi.yaml` |
| Eventos | `events/docs/contracts.md` |
| Inscrições e tópicos Kafka | `subscription/CONTRACTS.md` |
| Pagamentos, Relatórios, Certificados | `payments/README.md`, `reports/README.md`, `certificates/README.md` |
| Contratos entre equipes e perguntas em aberto | `docs/integration/contracts-with-team.md` |

## 7. Problemas comuns

| Sintoma | Causa provável |
|---|---|
| `404` imediato do Gateway | banco do Gateway antigo, veja a seção 2 |
| Todo token é recusado (`401`) | `USERS_JWT_ISSUER` mudou sem `JWT_ISSUER` no Gateway, ou a chave de `user/.keys` mudou depois de emitir o token |
| `user-db` ou `subscription-db` não inicia | senha ausente no `.env` |
| Participante virou organizador mas não vê a área | precisa sair e entrar de novo (o papel viaja no token de 30 min) |
| Muitos `429` no login ou cadastro | limite de 10 por minuto por IP |
| Inscrição fica `PENDING_PAYMENT` depois de aprovar | Kafka ou o relay da outbox fora do ar: `docker compose logs payments subscription kafka` |
