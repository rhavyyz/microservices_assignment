# Contratos e dependências com a equipe

> Estado: **backend de Usuários implementado (Fases 0–5)**; frontend na próxima etapa.
> Legenda: **Aprovado** (existe no código do repositório) · **Proposto** (sugestão desta entrega, aguardando confirmação) · **Pendente** (sem contrato; não foi inventado).
> Revisado sobre o `main` em `b0753be` (Gateway e Notificações já mesclados).
> **Atualização 2026-11-01:** a autenticação de JWT no Gateway (incluindo `/ws`) está **implementada na branch `feat/gateway-jwt-auth`, ainda não mesclada**. Linhas marcadas com "(branch)" valem só depois do merge; no `main`, o Gateway ainda apenas confere a presença de `X-User-Id`. Decisão em ADR-003.

## 1. Inventário do repositório

| Item | Estado encontrado | Consequência |
|---|---|---|
| `service-discoverer/` (Go) + libs Python/Go/**Java** | Implementado. Registro **em memória**; exige `GET /healthcheck` 2xx; remove hosts sem saúde após ~1 min. | Usuários usa a lib Java e **re-registra periodicamente** (ADR-003). |
| `gateway/` (Go) | **Implementado**: rota `/{kind}/...`, tabela de endpoints no MongoDB, CORS, rate limit, `/admin/endpoints`, WebSocket `/ws`. | Contrato lido do código (seção 2). Substitui as suposições anteriores P1–P4. |
| `notifications/` (Go) | Implementado (Kafka → MongoDB, API de listagem). | Não consome Usuários; usa `X-User-Id` (ver P13). |
| `user/` | **Serviço implementado** (Spring Boot 4.1, Java 21, PostgreSQL). | Esta entrega. |
| `events/`, `subscription/`, `payments/`, `reports/`, `certificates/` | Apenas placeholders. | Nenhum contrato disponível; nada foi simulado. |
| `docker-compose.yml` raiz | Kafka KRaft; sem portas publicadas no host. Entrada `user:` editada (única alteração). | **Não há porta pública do Gateway** (P1). |

## 2. Contrato do Gateway (Aprovado — lido do código)

| Comportamento | Detalhe | Efeito em Usuários |
|---|---|---|
| Roteamento | `/{kind}/resto` → instância saudável do kind (via discoverer), **prefixo `/{kind}` removido**. | O frontend chama `{GATEWAY}/user/api/v1/...`. |
| Descoberta de endpoints | O Gateway lê **`GET /openapi.json`** de cada kind (só `paths` + métodos) e registra cada par método/caminho. | O serviço publica `/openapi.json` (springdoc). |
| Visibilidade | Endpoints nascem **privados (404)**, `requireAuth=false`, `maxPerMin` padrão. Só `PUT /admin/endpoints` altera. | `user/scripts/register-gateway-routes.sh` abre os endpoints necessários. |
| `requireAuth` | `main`: apenas verifica que o cabeçalho **`X-User-Id` existe**; não valida identidade. **(branch)** O Gateway verifica o JWT (RS256, `iss`, `exp`, chave do JWKS de Usuários): sem token ou token inválido → `401`; sem chave disponível → `503`. | Mantido `false` em Usuários; o serviço valida o JWT. Ver P3. |
| Identidade injetada **(branch)** | Em toda rota o Gateway apaga `X-User-Id`/`X-User-Roles` do cliente; com token válido define `X-User-Id` = `sub` e `X-User-Roles` = `roles` (separadas por vírgula). Em rota sem `requireAuth`, token ausente ou inválido segue **anônimo**. `Authorization` é repassado sem alteração. | Usuários continua ignorando esses cabeçalhos e valida o próprio JWT. |
| WebSocket `/ws` **(branch)** | Token em `Authorization: Bearer` ou `?access_token=` (cabeçalho vence). `X-User-Id` e `?user_id=` **não são mais aceitos**. Falha → `401`/`503` antes do upgrade. A conexão aberta sobrevive ao `exp`. | Nenhum em Usuários. Mudança incompatível, aceita: o `/ws` ainda não tem consumidores. |
| CORS | Gateway responde preflight e define cabeçalhos; **reflete qualquer `Origin` com credenciais**; remove `Access-Control-*` do serviço. | Usuários **não** configura CORS (ADR-003). |
| Correlação | Usa **`X-Request-Id`** (gera se ausente; ecoa na resposta). | Usuários adota `X-Request-Id` em vez de `X-Correlation-Id` do prompt. |
| Rate limit | Por endpoint; `user_or_ip` usa `X-User-Id`. `main`: valor controlado pelo cliente. **(branch)** valor verificado (`sub`); um cabeçalho forjado não escolhe o balde. | Script usa `rateLimitBy=ip`. |
| Admin API | **Sem autenticação**, sem porta no host. | Não expor publicamente. |

### Rotas de Usuários no Gateway

| Método | Caminho público | Destino | Aberto pelo script | Limite |
|---|---|---|---|---|
| POST | `/user/api/v1/auth/register` | `/api/v1/auth/register` | sim | 10/min/IP |
| POST | `/user/api/v1/auth/login` | `/api/v1/auth/login` | sim | 10/min/IP |
| GET | `/user/api/v1/users/me` | `/api/v1/users/me` | sim | 120/min/IP |
| PATCH | `/user/api/v1/users/me` | `/api/v1/users/me` | sim | 30/min/IP |
| GET | `/user/api/v1/users?id=&email=&name=&page=&size=` | `/api/v1/users` | sim | 60/min/IP (somente `ORGANIZER`) |
| GET | `/.well-known/jwks.json` | — | **não** (servido direto via discoverer) | — |
| GET | `/healthcheck`, `/openapi.json` | — | **não** (internos) | — |

## 3. Contrato de descoberta (Aprovado)

`POST /register {"kind":"user","host":"host:porta"}` → 204; `GET /consult?kind=user` → `{"host":...}`. Variáveis: `SERVICE_DISCOVERER_URL`, `SERVICE_HOST`, `PORT`. Divergência com o prompt: `/healthcheck` (contrato do repositório) em vez de `/actuator/health`.

## 4. Pendências para a equipe

| # | Pergunta concreta | Proposta provisória | Quem confirma | Efeito |
|---|---|---|---|---|
| P1 | O Gateway não publica porta no host. Qual será a URL pública em dev? | Frontend lê `VITE_API_BASE_URL`, sem valor fixo no código. | Gateway | Só configuração; **bloqueia teste fim a fim**. |
| P3 | **Quem valida o JWT e define `X-User-Id`?** **Implementado na branch `feat/gateway-jwt-auth` (ADR-003, 2026-11-01); aguarda merge.** No `main` ainda ninguém: o Gateway só confere a presença do cabeçalho e Notificações confia nele (e no `user_id` da URL do `/ws`). | **O Gateway** valida o JWT (JWKS de Usuários), **remove** o `X-User-Id`/`X-User-Roles` recebidos e injeta `sub`/`roles`; o `/ws` segue a mesma regra. Restam em aberto: (a) `requireAuth=true` em `/users/me` (hoje `false`; o script de rotas não foi alterado); (b) **os serviços só podem confiar em `X-User-Id` se forem alcançáveis apenas pelo Gateway**, o que exige isolamento de rede e não é imposto por código; (c) Usuários continua **sem** confiar em `X-User-Id` e valida o próprio JWT. | Gateway + Notificações | Nenhuma em Usuários. Futuros clientes do `/ws` devem enviar o JWT (ver seção 2). |
| P5 | Como os serviços obtêm a chave pública? | `GET /.well-known/jwks.json` via `GET /consult?kind=user`. O Gateway **(branch)** faz isso com cache em memória, atualização a cada 10 min e nova busca (no máximo 1 por 30 s) quando chega um `kid` desconhecido. | Todos | Endpoint já existe. |
| P6 | `iss` e `aud`. | `iss=eventhub-users` (configurável; o Gateway lê `JWT_ISSUER`), sem `aud`. | Todos | Validação nos consumidores. |
| P7 | Fluxo aprovado para criar `ORGANIZER` em produção. | Nenhum endpoint; somente seed de dev (desligado por padrão). | Equipe/docente | Sem área de organizador real até decidir. |
| P8 | Usuários publica evento Kafka? | **Não.** Nenhum tópico criado. | Notificações | Sem Kafka no serviço. |
| P9 | Certificados: nome do participante por snapshot em Inscrições ou endpoint interno? | Nenhum endpoint criado. | Certificados + Inscrições | Nenhuma. |
| P10 | Onde o frontend é servido? | Pasta `frontend/` com build estático; compose raiz não alterado. | Equipe | Próxima etapa. |
| P12 | Força bruta no login. | Limite por IP no Gateway (script). Usuários não limita. IPs compartilhados (campus/NAT) podem ser bloqueados juntos. | Gateway | Limitação conhecida. |
| P13 | O cadastro retorna `409` para e-mail existente (exigido), o que permite enumerar e-mails. | Mitigar com o rate limit do Gateway. | Equipe | Aceito conscientemente. |
| P14 | O Gateway **reflete qualquer `Origin` com `Allow-Credentials: true`**. Hoje é inofensivo (Bearer em memória, sem cookies), mas vira falha se algum serviço passar a usar cookies. | Restringir às origens do frontend por ambiente. | Gateway | Nenhuma em Usuários. |
| P15 | O Gateway define `X-Request-Id` e o proxy copia o do serviço: o cabeçalho pode chegar duplicado (`a, a`). | Frontend usa o `traceId` do corpo de erro. | Gateway | Cosmético. |
| P16 | Sem `USERS_DB_PASSWORD` no `.env`, o `user-db` não inicia (de propósito, sem senha padrão) e o `user` fica aguardando; os demais serviços não são afetados. | Copiar `.env.example` para `.env`. | Equipe | Documentado no README. |
| P18 | **Busca de usuários** (`GET /api/v1/users`) expõe nome e e-mail de terceiros. Padrão adotado: somente `ORGANIZER`, ao menos um filtro, paginada (máx. 50), sem hash/senha, filtros fora dos logs. Um organizador enxerga **todos** os usuários (não só os inscritos em seus eventos). | Se o requisito for "só inscritos nos meus eventos", o filtro deve ficar com Inscrições; ou Usuários expõe consulta interna por lista de ids. | Equipe/docente | Decidir antes de usar em produção. |
| P17 | Compose raiz: entrada `user:` ganhou `build.additional_contexts`, `depends_on`, `environment` e `volumes` (padrão idêntico ao de `notifications`). | — | Equipe | Revisar o diff. |

## 5. Dependências por consumidor

| Consumidor | O que recebe de Usuários | Estado |
|---|---|---|
| Eventos | `sub` e `roles` do JWT; valida a responsabilidade pelo evento (RN07) | Proposto |
| Inscrições | `sub` do token validado (nunca `userId` do corpo) | Proposto |
| Pagamentos | Referência via Inscrições; sem acesso ao banco de Usuários | Proposto |
| Notificações | Contrato de mensagem a definir (P8); identifica por `X-User-Id`, que **(branch)** passa a ser definido pelo Gateway após verificar o JWT (P3) | Pendente |
| Check-in | Valida inscrição no domínio proprietário | Proposto |
| Certificados | Ver P9 | Pendente |
| Relatórios | Sem dados pessoais de Usuários | Proposto |

### Serviços atrás do Gateway **(branch)**
Um serviço que só recebe tráfego pelo Gateway **não precisa validar o JWT**: lê `X-User-Id` (UUID) e `X-User-Roles` (`PARTICIPANT`/`ORGANIZER`, separadas por vírgula; ausente se não houver). Ausência de `X-User-Id` significa requisição anônima. Isso só é seguro se o serviço **não for alcançável por outro caminho**; do contrário, valide o token como abaixo.

### Como um consumidor valida o token (Proposto)
RS256; chave pública em `GET /consult?kind=user` → `http://<host>/.well-known/jwks.json` (`kid` na assinatura); exigir `iss`, `exp` e assinatura. Claims: `sub` (UUID), `roles` (`PARTICIPANT`/`ORGANIZER`), `iss`, `iat`, `exp`, `jti`.
