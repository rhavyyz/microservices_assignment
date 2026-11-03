# ADR-003 — Gateway, descoberta e health check

- **Estado:** Health check, descoberta e contrato do Gateway: **Aprovado** (lidos do código do repositório). Porta pública do Gateway: pendente (P1).
- **Data:** 2026-10-30

## Contexto
O repositório define um `service-discoverer` (Go) com libs cliente e exige `GET /healthcheck` com 2xx. O Gateway foi implementado depois da primeira versão deste ADR e foi lido em `b0753be`. O frontend só deve conhecer a URL pública do Gateway.

## Decisão
1. **Health check em `/healthcheck`** (e não `/actuator/health`): Actuator com `management.endpoints.web.base-path=/` e `management.endpoints.web.path-mapping.health=healthcheck`, sem detalhes e sem expor outros endpoints. O grupo de saúde inclui o banco: se o banco cai, a instância sai da descoberta. A consulta é leve (validação de conexão).
2. **Registro no discoverer** com a lib Java existente (`Discovery.register(Kind.USER)`), usando `SERVICE_HOST` e `PORT`. Executado em segundo plano na inicialização, com falha apenas registrada em log: indisponibilidade do discoverer não impede o serviço de iniciar nem de atender requisições (RQ03).
3. O serviço de Usuários **não consulta** outros serviços (não precisa de nenhum), logo não usa `consult`/`request`.
4. **Consumo da lib:** ela não é publicada em repositório Maven. Proposta: `build.additional_contexts` na entrada `user:` do compose raiz e `mvn install` da lib em um estágio do Dockerfile. Alternativa, se a equipe preferir não editar o compose raiz: copiar a lib para dentro de `user/` (duplicação).
5. **Frontend → Gateway:** URL em `VITE_API_BASE_URL`; sem endereços internos. Rotas propostas em `contracts-with-team.md`.
6. **Gateway não implementado** nesta entrega.

## Alternativas
- Manter `/actuator/health`: quebra o contrato do discoverer.
- Duas rotas de health: duplicação sem necessidade.
- Falhar a inicialização se o registro falhar: acopla a disponibilidade ao discoverer.

## Consequências
- Sem porta publicada no host e sem Gateway, não há como testar o fluxo fim a fim até o Gateway existir.
- A lib Java `register` bloqueia por até ~5 s (5 tentativas): por isso roda em thread própria.

## Atualização após o merge do Gateway (2026-10-31)
- **Prefixo e registro:** o Gateway remove `/user` e registra as rotas lendo `GET /openapi.json`; o serviço o publica via springdoc (gerado do código, logo sempre igual às rotas reais). Endpoints nascem privados; `user/scripts/register-gateway-routes.sh` os abre.
- **Correlação:** adotado `X-Request-Id` (o do Gateway) em vez de `X-Correlation-Id`; valor recebido só é aceito com formato seguro.
- **CORS:** o Gateway responde preflights e **remove** `Access-Control-*` do serviço; configurar CORS em Usuários seria código morto. Decisão: Usuários não configura CORS. (Exigência do prompt de restringir origens fica com o Gateway: P14.)
- **Identidade:** ~~o `X-User-Id` do Gateway não é verificado (P3)~~ — **substituído pela atualização de 2026-11-01 abaixo.** Usuários ignora esse cabeçalho e usa somente o `sub` do JWT; por isso `requireAuth` fica `false` nas rotas de Usuários.
- **Re-registro:** o registry do discoverer é em memória e descarta hosts sem saúde; a instância chama `register` a cada 30 s (idempotente), sem bloquear o início.

## Atualização: o Gateway autentica o JWT (2026-11-01)
> Estado: **implementado na branch `feat/gateway-jwt-auth`, ainda não mesclado no `main`.** Resolve P3 em `contracts-with-team.md`.

### Contexto
O Gateway só conferia a presença de `X-User-Id`, um cabeçalho controlado pelo cliente. Qualquer um podia se passar por outro usuário no rate limit, nos serviços que confiam no cabeçalho e no `/ws` (que ainda aceitava `?user_id=`).

### Decisão
1. **O Gateway é a fronteira de confiança de identidade.** Ele verifica o JWT localmente e injeta `X-User-Id` (= `sub`) e `X-User-Roles` (= `roles`, separadas por vírgula). Nenhuma chamada a Usuários por requisição.
2. **Remoção antes da injeção.** Em toda rota (pública ou não, com ou sem token) o Gateway apaga os `X-User-Id` e `X-User-Roles` enviados pelo cliente. Esses cabeçalhos só podem vir do Gateway.
3. **Verificação estrita:** somente `RS256`; `exp` obrigatório; `iss` igual a `JWT_ISSUER` (padrão `eventhub-users`); `sub` não vazio; tolerância de relógio de 30 s. A chave vem **somente** do JWKS de Usuários (`GET /.well-known/jwks.json`, obtido via discoverer ou `USERS_JWKS_URL`); nunca de `jku`/`jwk`/`kid` do próprio token. `alg=none` e HS256 com a chave pública como segredo são recusados.
4. **Cache de chaves:** em memória, por `kid`. Atualização periódica (`JWKS_REFRESH_EVERY`, padrão 10 min; substitui o conjunto, então chaves aposentadas saem). `kid` desconhecido dispara uma busca compartilhada, no máximo uma por `JWKS_REFETCH_COOLDOWN` (padrão 30 s), para que `kid`s aleatórios não sobrecarreguem Usuários. O Gateway inicia mesmo se o JWKS estiver fora do ar.
5. **Resposta por tipo de rota:**
   - `requireAuth=true`: sem token ou token inválido → `401` com `WWW-Authenticate: Bearer`; sem chave disponível (JWKS fora do ar e nada em cache) → `503`.
   - `requireAuth=false`: token ausente ou inválido não rejeita; a requisição segue **anônima** (sem cabeçalhos de identidade) e o serviço decide. Assim login e cadastro funcionam mesmo com um token vencido no navegador.
6. **`Authorization` é repassado sem alteração**, porque Usuários continua validando o próprio JWT (defesa em profundidade; ver "Não decidido").
7. **Rate limit `user_or_ip`** passa a usar a identidade verificada: um `X-User-Id` forjado não escolhe o balde.
8. **`/ws`** segue as mesmas regras: o token vem em `Authorization: Bearer` ou, para navegadores (que não definem cabeçalhos em `new WebSocket(...)`), em `?access_token=`; o cabeçalho tem precedência. O `?user_id=` deixou de existir; a identidade do hub é somente o `sub` verificado. Falhas respondem `401`/`503` **antes** do upgrade.

### Alternativas
- **Endpoint em Usuários que traduz JWT em usuário** (introspecção): descartado. O `sub` já está no token assinado; a chamada por requisição acopla toda rota autenticada à disponibilidade e ao banco de Usuários.
- **Chave pública por configuração** (alternativa já citada no ADR-001): mais simples, mas a rotação exige alterar a configuração do Gateway. Mantida como contingência via `USERS_JWKS_URL`.
- **Token do `/ws` em subprotocolo (`Sec-WebSocket-Protocol`)**: evita a URL, porém é pouco convencional e mais frágil nos clientes. Não adotado.

### Consequências
- Notificações e os demais serviços podem confiar em `X-User-Id`, **desde que só sejam alcançáveis pelo Gateway**. Isso não é imposto por código; precisa de isolamento de rede (ver "Não decidido").
- **Mudança incompatível no `/ws`:** `X-User-Id` e `?user_id=` deixam de ser aceitos e o cliente deve enviar o JWT. Hoje o `/ws` não tem consumidores, então a quebra é aceita sem período de transição.
- O token na URL do `/ws` pode aparecer em logs de proxies e balanceadores fora do Gateway (o Gateway não registra a query). Exigem TLS; o tempo de vida curto do token (30 min) limita o dano.
- Uma conexão `/ws` aberta sobrevive ao `exp` do token: a verificação ocorre só no upgrade.
- Sem revogação antes do `exp` (ADR-001) e sem refresh token: o usuário reautentica a cada 30 min.
- Os `requireAuth` armazenados **não mudaram**: as rotas de Usuários continuam com `requireAuth=false` e `user/scripts/register-gateway-routes.sh` não foi alterado.

### Não decidido
- Se Usuários deve passar a confiar apenas em `X-User-Id` (e abandonar a própria validação do JWT). Só é seguro depois que o isolamento de rede e um segredo ou mTLS entre Gateway e serviços estiverem garantidos; até lá, Usuários mantém a validação.
- Se `requireAuth` deve passar a `true` em `GET/PATCH /user/api/v1/users/me`.
- Rotação de chaves em Usuários (publicar duas chaves no JWKS) e claim `aud`.
- Refresh token e logout.
