# Decisões técnicas complementares (DT)

As **decisões de arquitetura** do projeto estão nos três ADRs em [`docs/decisions/`](../decisions/): [ADR-001](../decisions/ADR-001-service-decomposition.md) (decomposição por capacidade de negócio), [ADR-002](../decisions/ADR-002-service-communication.md) (comunicação híbrida, Kafka declarativo e Outbox) e [ADR-003](../decisions/ADR-003-data-ownership-and-persistence.md) (banco por serviço e consistência eventual).

Este arquivo guarda o **detalhe de implementação** das decisões menores que antes eram ADRs separados (identidade, Gateway, pilha, tópicos, certificados, frontend, contrato de Inscrições/Pagamentos, Eventos e administração). Cada seção (DT-01 a DT-11) mantém o texto original, sem perda. Os nomes DT-nn substituem os antigos ADR-004 a ADR-009 e as numerações antigas ADR-001 a ADR-003 de identidade, papéis e Gateway.

| Id | Assunto | Antigo |
|---|---|---|
| [DT-01](#dt-01) | Access Token e assinatura | ADR-001 |
| [DT-02](#dt-02) | Papéis de usuário | ADR-002 |
| [DT-03](#dt-03) | Gateway, descoberta e health check | ADR-003 |
| [DT-04](#dt-04) | Versões, dependências e estratégia de testes do backend | ADR-004 |
| [DT-05](#dt-05) | Tópicos Kafka são criados pelo serviço que os usa, antes de consumir ou publicar | ADR-005 |
| [DT-06](#dt-06) | Certificados são emitidos somente a partir de eventos de presença | ADR-006 |
| [DT-07](#dt-07) | Frontend: sessão em memória e pilha | ADR-006 |
| [DT-08](#dt-08) | Frontend da aplicação inteira: escopo por fases e decisões da fase A1 | ADR-007 |
| [DT-09](#dt-09) | Inscrições é declarativa; Pagamentos reage aos eventos | ADR-007 |
| [DT-10](#dt-10) | Eventos encerra atividades e segue o contrato de Inscrições | ADR-008 |
| [DT-11](#dt-11) | Papel ADMIN e pedido de organizador | ADR-009 |

## DT-01 — Access Token e assinatura

- **Estado:** Proposto (aguarda confirmação da equipe — P3, P5, P6)
- **Data:** 2026-10-30

### Contexto
O padrão acordado é *Access Token*. Todos os serviços precisam validar assinatura, emissor e expiração sem consultar o banco de Usuários. O `docker-compose` raiz permite várias réplicas por serviço (`deploy.replicas`).

### Decisão
- JWT assinado com **RS256** (Nimbus JOSE + JWT via Spring Security; nenhuma segunda biblioteca JWT).
- Claims: `sub` (UUID), `roles`, `iss`, `iat`, `exp`, `jti`. Sem senha nem dados de perfil.
- Validade em `USERS_JWT_TTL_SECONDS` (padrão 1800). Emissor em `USERS_JWT_ISSUER` (padrão `eventhub-users`).
- **A chave privada é injetada por configuração** (`USERS_JWT_PRIVATE_KEY_FILE`, PEM montado como secret) e **nunca gerada por instância**: com réplicas, uma chave por instância faria tokens emitidos por uma réplica serem rejeitados por outra. `kid` configurável (`USERS_JWT_KEY_ID`).
- Chave pública exposta em `GET /.well-known/jwks.json`; consumidores localizam o serviço via `GET /consult?kind=user` do discoverer. Alternativa aceita: distribuir a chave pública por configuração.
- Sem refresh token e sem servidor OAuth completo no escopo inicial.
- Chaves de desenvolvimento são geradas por script local, em diretório ignorado pelo git.

### Alternativas
- **HS256 (segredo compartilhado):** descartado; todo consumidor poderia forjar tokens.
- **Token opaco com introspecção:** descartado; acopla todos os serviços a Usuários em cada requisição (RQ01/RQ03).
- **Chave gerada na inicialização:** descartada pelo problema das réplicas.

### Consequências
- Rotação de chave exige publicar duas chaves no JWKS durante a transição (fora do escopo inicial).
- Revogação antes do `exp` não é suportada; mitigada pela validade curta.


## DT-02 — Papéis de usuário

- **Estado:** Proposto; a criação de organizadores foi definida no [DT-11](#dt-11) (papel `ADMIN` e pedido de organizador)
- **Data:** 2026-10-30

### Contexto
RF01 exige diferenciar participantes e organizadores. RN07 diz que ser `ORGANIZER` **não** dá acesso a todos os eventos: a responsabilidade pelo evento é validada pelo serviço de Eventos.

### Decisão
- Papéis: `PARTICIPANT` e `ORGANIZER`, em tabela `user_roles` (um usuário pode ter mais de um).
- O cadastro público cria **somente** `PARTICIPANT`. Campos como `roles`, `isAdmin` ou `isOrganizer` são **rejeitados** (`400 MALFORMED_REQUEST`), não ignorados em silêncio.
- `PATCH /users/me` altera apenas `name`.
- Não há endpoint de promoção. Em desenvolvimento local, um seed de organizador de demonstração fica **desativado por padrão** e só é ativado por `USERS_DEV_SEED_ENABLED=true` com credenciais vindas do ambiente (nunca do repositório).
- O fluxo de criação de organizadores em produção é decisão da equipe (P7).
- O papel no JWT é apenas informativo para os consumidores; autorização por recurso é do serviço dono do recurso.

### Alternativas
- **Auto-declaração no cadastro:** inseguro.
- **Endpoint administrativo de promoção:** sem requisito aprovado; evita-se superfície de ataque.

### Consequências
Sem fluxo de produção para `ORGANIZER`, a área de organizador só pode ser demonstrada com o seed de desenvolvimento.


## DT-03 — Gateway, descoberta e health check

- **Estado:** Health check, descoberta e contrato do Gateway: **Aprovado** (lidos do código do repositório). Porta pública do Gateway: pendente (P1).
- **Data:** 2026-10-30

### Contexto
O repositório define um `service-discoverer` (Go) com libs cliente e exige `GET /healthcheck` com 2xx. O Gateway foi implementado depois da primeira versão deste ADR e foi lido em `b0753be`. O frontend só deve conhecer a URL pública do Gateway.

### Decisão
1. **Health check em `/healthcheck`** (e não `/actuator/health`): Actuator com `management.endpoints.web.base-path=/` e `management.endpoints.web.path-mapping.health=healthcheck`, sem detalhes e sem expor outros endpoints. O grupo de saúde inclui o banco: se o banco cai, a instância sai da descoberta. A consulta é leve (validação de conexão).
2. **Registro no discoverer** com a lib Java existente (`Discovery.register(Kind.USER)`), usando `SERVICE_HOST` e `PORT`. Executado em segundo plano na inicialização, com falha apenas registrada em log: indisponibilidade do discoverer não impede o serviço de iniciar nem de atender requisições (RQ03).
3. O serviço de Usuários **não consulta** outros serviços (não precisa de nenhum), logo não usa `consult`/`request`.
4. **Consumo da lib:** ela não é publicada em repositório Maven. Proposta: `build.additional_contexts` na entrada `user:` do compose raiz e `mvn install` da lib em um estágio do Dockerfile. Alternativa, se a equipe preferir não editar o compose raiz: copiar a lib para dentro de `user/` (duplicação).
5. **Frontend → Gateway:** URL em `VITE_API_BASE_URL`; sem endereços internos. Rotas propostas em `contracts-with-team.md`.
6. **Gateway não implementado** nesta entrega.

### Alternativas
- Manter `/actuator/health`: quebra o contrato do discoverer.
- Duas rotas de health: duplicação sem necessidade.
- Falhar a inicialização se o registro falhar: acopla a disponibilidade ao discoverer.

### Consequências
- Sem porta publicada no host e sem Gateway, não há como testar o fluxo fim a fim até o Gateway existir.
- A lib Java `register` bloqueia por até ~5 s (5 tentativas): por isso roda em thread própria.

### Atualização após o merge do Gateway (2026-10-31)
- **Prefixo e registro:** o Gateway remove `/user` e registra as rotas lendo `GET /openapi.json`; o serviço o publica via springdoc (gerado do código, logo sempre igual às rotas reais). Endpoints nascem privados; `user/scripts/register-gateway-routes.sh` os abre.
- **Correlação:** adotado `X-Request-Id` (o do Gateway) em vez de `X-Correlation-Id`; valor recebido só é aceito com formato seguro. Depois renomeado para `X-Trace-Id` (e `request_id` para `trace_id` nos eventos), sem fallback para o nome antigo.
- **CORS:** o Gateway responde preflights e **remove** `Access-Control-*` do serviço; configurar CORS em Usuários seria código morto. Decisão: Usuários não configura CORS. (Exigência do prompt de restringir origens fica com o Gateway: P14.)
- **Identidade:** ~~o `X-User-Id` do Gateway não é verificado (P3)~~ — **substituído pela atualização de 2026-11-01 abaixo.** Usuários ignora esse cabeçalho e usa somente o `sub` do JWT; por isso `requireAuth` fica `false` nas rotas de Usuários.
- **Re-registro:** o registry do discoverer é em memória e descarta hosts sem saúde; a instância chama `register` a cada 30 s (idempotente), sem bloquear o início.

### Atualização: o Gateway autentica o JWT (2026-11-01)
> Estado: **implementado e mesclado no `main`** (PR #7). Resolve P3 em `contracts-with-team.md`.

#### Contexto
O Gateway só conferia a presença de `X-User-Id`, um cabeçalho controlado pelo cliente. Qualquer um podia se passar por outro usuário no rate limit, nos serviços que confiam no cabeçalho e no `/ws` (que ainda aceitava `?user_id=`).

#### Decisão
1. **O Gateway é a fronteira de confiança de identidade.** Ele verifica o JWT localmente e injeta `X-User-Id` (= `sub`) e `X-User-Roles` (= `roles`, separadas por vírgula). Nenhuma chamada a Usuários por requisição.
2. **Remoção antes da injeção.** Em toda rota (pública ou não, com ou sem token) o Gateway apaga os `X-User-Id` e `X-User-Roles` enviados pelo cliente. Esses cabeçalhos só podem vir do Gateway.
3. **Verificação estrita:** somente `RS256`; `exp` obrigatório; `iss` igual a `JWT_ISSUER` (padrão `eventhub-users`); `sub` não vazio; tolerância de relógio de 30 s. A chave vem **somente** do JWKS de Usuários (`GET /.well-known/jwks.json`, obtido via discoverer ou `USERS_JWKS_URL`); nunca de `jku`/`jwk`/`kid` do próprio token. `alg=none` e HS256 com a chave pública como segredo são recusados.
4. **Cache de chaves:** em memória, por `kid`. Atualização periódica (`JWKS_REFRESH_EVERY`, padrão 10 min; substitui o conjunto, então chaves aposentadas saem). `kid` desconhecido dispara uma busca compartilhada, no máximo uma por `JWKS_REFETCH_COOLDOWN` (padrão 30 s), para que `kid`s aleatórios não sobrecarreguem Usuários. O Gateway inicia mesmo se o JWKS estiver fora do ar.
5. **Resposta por tipo de rota:**
   - `requireAuth=true`: sem token ou token inválido → `401` com `WWW-Authenticate: Bearer`; sem chave disponível (JWKS fora do ar e nada em cache) → `503`.
   - `requireAuth=false`: token ausente ou inválido não rejeita; a requisição segue **anônima** (sem cabeçalhos de identidade) e o serviço decide. Assim login e cadastro funcionam mesmo com um token vencido no navegador.
6. **`Authorization` é repassado sem alteração**, porque Usuários continua validando o próprio JWT (defesa em profundidade; ver "Não decidido") e porque alguns serviços o reencaminham (Inscrições → Eventos).
7. **Rate limit `user_or_ip`** passa a usar a identidade verificada: um `X-User-Id` forjado não escolhe o balde.
8. **`/ws`** segue as mesmas regras: o token vem em `Authorization: Bearer` ou, para navegadores (que não definem cabeçalhos em `new WebSocket(...)`), em `?access_token=`; o cabeçalho tem precedência. O `?user_id=` deixou de existir; a identidade do hub é somente o `sub` verificado. Falhas respondem `401`/`503` **antes** do upgrade.

#### Alternativas
- **Endpoint em Usuários que traduz JWT em usuário** (introspecção): descartado. O `sub` já está no token assinado; a chamada por requisição acopla toda rota autenticada à disponibilidade e ao banco de Usuários.
- **Chave pública por configuração** (alternativa já citada no DT-01): mais simples, mas a rotação exige alterar a configuração do Gateway. Mantida como contingência via `USERS_JWKS_URL`.
- **Token do `/ws` em subprotocolo (`Sec-WebSocket-Protocol`)**: evita a URL, porém é pouco convencional e mais frágil nos clientes. Não adotado.

#### Consequências
- Notificações e os demais serviços podem confiar em `X-User-Id`, **desde que só sejam alcançáveis pelo Gateway**. Isso não é imposto por código; precisa de isolamento de rede (ver "Não decidido").
- **Mudança incompatível no `/ws`:** `X-User-Id` e `?user_id=` deixam de ser aceitos e o cliente deve enviar o JWT. Hoje o `/ws` não tem consumidores, então a quebra é aceita sem período de transição.
- O token na URL do `/ws` pode aparecer em logs de proxies e balanceadores fora do Gateway (o Gateway não registra a query). Exigem TLS; o tempo de vida curto do token (30 min) limita o dano.
- Uma conexão `/ws` aberta sobrevive ao `exp` do token: a verificação ocorre só no upgrade.
- Sem revogação antes do `exp` (DT-01) e sem refresh token: o usuário reautentica a cada 30 min.
- Os `requireAuth` armazenados **não mudaram**: as rotas de Usuários continuam com `requireAuth=false` e `user/scripts/register-gateway-routes.sh` não foi alterado.

#### Não decidido
- Se Usuários deve passar a confiar apenas em `X-User-Id` (e abandonar a própria validação do JWT). Só é seguro depois que o isolamento de rede e um segredo ou mTLS entre Gateway e serviços estiverem garantidos; até lá, Usuários mantém a validação.
- Se `requireAuth` deve passar a `true` em `GET/PATCH /user/api/v1/users/me`.
- Rotação de chaves em Usuários (publicar duas chaves no JWKS) e claim `aud`.
- Refresh token e logout.

### Atualização: Inscrições confia nos cabeçalhos do Gateway (2026-11-03)
> Estado: **implementado na branch `feat/subscription-gateway-identity`, ainda não mesclado.** Vale para serviços que não emitem tokens; Usuários não muda e o Gateway não muda.

#### Contexto
Inscrições validava o JWT por conta própria (PyJWT + JWKS). Medido em teste de integração com a pilha real:
- **Dependência do discoverer a cada requisição.** Sem `USERS_JWKS_URL`, o serviço pergunta ao discoverer onde está Usuários antes de verificar cada token. Com o discoverer pausado, um token válido recebeu `503` após 5 s (contra 14 ms normalmente), embora a chave estivesse em cache.
- **Rotação de chave.** A biblioteca não rebusca o JWKS ao ver um `kid` desconhecido; tokens assinados com a chave nova são recusados até o cache expirar (300 s).
Verificar de novo o que o Gateway já verificou duplica a lógica e cria dois pontos de divergência (relógio, algoritmo, chaves).

#### Decisão
1. **Modelo de rede fechada.** O Gateway é a única porta publicada no host; os demais serviços não publicam portas e só são alcançáveis de dentro da rede. Quem não faz parte da rede só fala com o sistema pelo Gateway.
2. Serviços atrás do Gateway que **não emitem tokens** confiam em `X-User-Id` (UUID, obrigatório; ausente ou inválido → `401 UNAUTHENTICATED`) e `X-User-Roles` (separadas por vírgula). O Gateway já descarta os valores enviados pelo cliente e define esses cabeçalhos a partir do JWT verificado (decisões 1 e 2 acima). Usuários continua validando o próprio JWT por ser o emissor.
3. **Propagação de identidade nas chamadas de saída.** Nas chamadas feitas em nome de um usuário (ex.: Inscrições → Eventos para ler a atividade e checar `permissions/me`), Inscrições envia `X-User-Id`, `X-User-Roles` (quando houver) e `X-Trace-Id` (rastreio) e continua repassando o `Authorization`, **sem verificá-lo**. Chamadas em segundo plano (reação a `events.events`, reconciliação de pagamentos) não têm usuário e não enviam identidade. Não há segredo entre serviços: o `SUBSCRIPTION_SERVICE_TOKEN`/`X-Service-Token` previsto no PR #8 foi removido, e os endpoints `/internal/...` dependem do isolamento de rede.
4. As rotas de Inscrições passam a ser registradas no Gateway com `requireAuth=true` e `rateLimitBy=user_or_ip` (o Gateway verifica o token; o identificador agora é confiável).

#### Alternativas
- **Segredo compartilhado Gateway → serviços** (`X-Gateway-Token`): avaliado e **descartado** pelo time. Protegeria contra um contêiner interno forjando `X-User-Id`, mas a decisão é tratar a rede interna como confiável e proteger a borda.
- **Manter a validação local e só eliminar a ida ao discoverer** (definir `USERS_JWKS_URL` ou guardar o host de Usuários em cache): resolve a falha do primeiro item do contexto, mas não a rotação de chave nem a duplicação. Continua válida como contingência.
- **mTLS entre Gateway e serviços:** mais forte, porém mais trabalho; fora do escopo desta fase.
- **`X-Service-Token` nas chamadas de Inscrições a Eventos/Pagamentos:** removido pelo mesmo motivo do `X-Gateway-Token` (rede interna confiável).

#### Consequências
- **Quem está dentro da rede é confiável.** Qualquer contêiner na rede `backbone` pode chamar Inscrições diretamente com um `X-User-Id` arbitrário e se passar por qualquer usuário. Isso é aceito pelo modelo; vale enquanto só serviços da própria equipe estiverem na rede e nenhum serviço (exceto o Gateway) publicar porta no host.
- Qualquer nova porta publicada em outro serviço (por exemplo `ports:` em um compose) **anula** essa proteção para ele e precisa de revisão.
- Os testes de token forjado/expirado de Inscrições saem do serviço; essa responsabilidade é do Gateway (`gateway/auth_test.go`).

#### Não decidido
- Se o `Authorization` deve continuar sendo reencaminhado ao Eventos, agora que ele também recebe `X-User-Id`/`X-User-Roles`.
- Se os demais serviços (Eventos, Pagamentos, Notificações) adotam o mesmo modelo de cabeçalhos.

### Atualização: configurações do endpoint declaradas pelo serviço, `x-gateway` (2026-11-05)

#### Contexto
O Gateway cadastrava todo endpoint novo como privado, com os padrões, e cada serviço precisava de um script (`PUT /admin/endpoints`) para abrir suas rotas. A descrição do endpoint (OpenAPI) já é lida na sincronização, mas só trazia método e caminho.

#### Decisão
1. Cada operação do `GET /openapi.json` pode declarar `x-gateway` (extensão de fornecedor) com `isPublic`, `requireAuth`, `maxPerMin` e `rateLimitBy`, os mesmos nomes da API admin. Todas as chaves são opcionais; o que faltar (ou for inválido) usa o padrão de hoje: privado, `requireAuth=false`, `DEFAULT_MAX_PER_MIN`, `user_or_ip`.
2. A declaração vale **apenas na primeira inserção** do endpoint. Endpoint já armazenado nunca é sobrescrito pela especificação: o `PUT /admin/endpoints` continua sendo a autoridade em tempo de execução, e mudar a declaração depois não altera um endpoint já armazenado. Para reaplicar, o admin faz `PUT` com os valores ou apaga o documento do endpoint.
3. Valor inválido em uma chave é ignorado só naquela chave e registrado no log; `x-gateway` que não é objeto é ignorado. Nunca falha a sincronização.

#### Alternativas
- **A especificação como fonte contínua da verdade** (reaplicar a declaração a cada sincronização): **descartada**, pois desfaria as edições feitas pelo admin em produção e tiraria dele o controle em tempo de execução.

#### Consequências
- **Risco aceito:** um serviço agora pode declarar a si mesmo como público. Mitigação: rede confiável, os serviços são da própria equipe e a API admin segue como controle em tempo de execução (pode fechar o endpoint a qualquer momento).
- Só a primeira inserção honra a declaração; endpoints já existentes no banco continuam como estão até um `PUT` ou até o documento ser apagado.
- Os scripts de registro existentes continuam válidos e não foram alterados.

### Atualização: o Gateway usa a lib de descoberta compartilhada (2026-11-06)
O cliente do discoverer escrito à mão no Gateway (`GET /consult`, mapeamento de status) foi removido. Agora o Gateway usa a lib Go compartilhada (`service-discoverer/Libs/go`, mesma de Notificações, via `replace` no `go.mod` e contexto de build `discovery` no compose). A lib exporta `ErrNoInstance` (consult 503) e `ErrUnknownKind` (consult 400). O `Discovery` do Gateway continua guardando um host por kind, porque o proxy reverso precisa do host (`httputil.ReverseProxy` não passa por `Request`); sua consulta chama `discovery.Consult`, e `SERVICE_DISCOVERER_URL` passa a ser lida pela lib. O JWKS (sem `USERS_JWKS_URL`) e o `/openapi.json` de cada serviço são buscados com `discovery.Request`, que guarda o host e redescobre uma vez se a conexão falhar. A lib não recebe `context`: o Gateway abandona a espera quando o contexto é cancelado, e a chamada termina em segundo plano limitada ao timeout de 5 s da lib. O texto acima descreve o estado de então; o comportamento observável (503 sem instância, 404/400, esquecer o host que falhou) não mudou.

### Atualização: documentação OpenAPI única no Gateway (2026-11-06)
O Gateway publica `GET /openapi.json` (um único documento OpenAPI 3.0.3 que reúne as especificações de todos os tipos) e `GET /docs` (Swagger UI, `swagger-ui-dist` 5.17.14 via jsdelivr). Ambas as rotas são públicas e atendidas pelo próprio Gateway, fora do pipeline de endpoints.
- O documento lista **somente** as operações públicas na tabela de endpoints em vigor (inclui mudanças feitas pela API admin, sem reiniciar); endpoints privados nunca aparecem. Caminhos viram `/{kind}/<caminho do serviço>`, `security` segue `requireAuth` e `x-gateway` mostra os valores efetivos. Componentes são renomeados `<Kind>_<nome>` para não colidirem.
- As especificações são buscadas na inicialização (com retentativas) e a cada `DOCS_REFRESH_EVERY` (padrão 5 min); uma falha mantém a cópia anterior e a descrição cita os tipos indisponíveis.


## DT-04 — Versões, dependências e estratégia de testes do backend

- **Estado:** Aceito
- **Data:** 2026-10-31

### Contexto
O repositório não define pilha para Usuários. O prompt exige versões estáveis e suportadas. Consulta em 2026-10-31: Spring Boot **4.1** (GA em 2026-06-10, patch 4.1.1 em 2026-08-20) e 4.0 (suporte OSS até 2026-12-31) estão suportados; a 3.5 saiu de suporte em 2026-06-30.

### Decisão
- **Java 21 (LTS)**, **Spring Boot 4.1.1** (Spring Framework 7, Security 7, Jackson 3, Hibernate 7), Maven com wrapper oficial 3.3.4 (Maven 3.9.11).
- Starters do Boot 4 (nomes novos): `webmvc`, `security`, `security-oauth2-resource-server`, `data-jpa`, `validation`, `actuator`, `flyway` (+ `flyway-database-postgresql`).
- **springdoc-openapi 3.0.3** (`webmvc-api`, sem Swagger UI). *Risco:* a linha 3.x declara suporte ao Boot 4.0; a compatibilidade com 4.1 não foi confirmada em fonte oficial. Se falhar ao iniciar, o Gateway não aprende as rotas: é o primeiro ponto a verificar.
- **Testcontainers 2.x** (versão do BOM do Boot), isolado em `PostgresIT`.
- **JWT:** uma só biblioteca (Nimbus, via Spring Security) para emitir e validar.
- **BCrypt** com custo 12 (configurável); Argon2id descartado por exigir dependência extra (BouncyCastle).
- Erros em `application/problem+json` montado à mão em `Problems`: o mesmo formato serve ao MVC e à cadeia de segurança, sem depender da configuração do Jackson 3.
- Testes: `*Test` (surefire, sem Docker) e `*IT` (failsafe, PostgreSQL real via Docker). Os ITs usam o cliente HTTP do JDK contra o Tomcat real em vez de `MockMvc`, para exercitar filtros e segurança de ponta a ponta sem depender de pacotes de teste específicos do Boot 4.

### Alternativas
- Boot 3.5: sem suporte desde junho de 2026. Boot 4.0: suporte acaba em 2026-12-31.
- H2 nos ITs: não valida constraints do PostgreSQL real.

### Consequências
O código foi inicialmente escrito sem acesso ao Maven Central. A primeira execução real (ver `docs/testing/test-report.md`) confirmou as premissas de API do Boot 4.1.1, springdoc 3.0.3 × Boot 4.1, Testcontainers 2.0.5 (`org.testcontainers.postgresql.PostgreSQLContainer`) e `spring.jackson.deserialization.fail-on-unknown-properties`: tudo compilou e funcionou. Os únicos ajustes foram bugs de teste.


## DT-05 — Tópicos Kafka são criados pelo serviço que os usa, antes de consumir ou publicar

- **Estado:** Aceito (implementado em Inscrições e no Gateway; Notificações já fazia isso)
- **Data:** 2026-11-03

### Contexto
O Kafka do compose raiz cria tópicos automaticamente quando alguém publica, mas um consumidor que assinou um tópico **antes** de ele existir só o enxerga no próximo refresh de metadados do cliente. Em teste de ponta a ponta com a pilha real, o Inscrições (cliente librdkafka, padrão de 5 min) levou cerca de 3,5 min para reagir a um `ActivityCancelled` publicado logo após o início; com o tópico já conhecido, a reação levou cerca de 2 s. O Gateway mitiga com refresh de 30 s, mas também não cria o tópico.

### Decisão
1. **Todo serviço que consome ou publica em um tópico garante que ele existe antes de começar** (criação se ausente, na inicialização). A falha do Kafka não impede o serviço de iniciar: a garantia roda em segundo plano, com repetição e espera crescente (2 s até 30 s), e o consumo/publicação só começa depois dela.
2. **Só cria; nunca altera um tópico existente.** Sem aumentar partições nem mudar configuração, porque isso remapeia as chaves das mensagens e quebra a ordem por chave. (Notificações aumenta partições dos próprios tópicos; é uma exceção antiga e não deve ser copiada.)
3. **Partições padrão: 6**, o mesmo padrão de Notificações, para que quem criar primeiro crie o mesmo tópico. Cada serviço aceita uma variável de ambiente própria para o número (`SUBSCRIPTION_TOPIC_PARTITIONS`, `NOTIFICATIONS_PUSH_PARTITIONS`, `NOTIFICATIONS_PARTITIONS`). Replicação 1 (Kafka de nó único).
4. **Rede de segurança no consumidor:** o cliente de Inscrições confere novos tópicos a cada 10 s (`topic.metadata.refresh.interval.ms`), para o caso de um tópico ser criado por outra equipe depois.
5. Serviços ainda sem código (Eventos, Pagamentos, Relatórios, Certificados) devem seguir a mesma regra quando passarem a usar Kafka.

### Alternativas
- **Pré-criar os tópicos no compose ou em um serviço de inicialização:** centraliza, mas cria um novo componente e uma lista a manter em paralelo ao código; a regra "quem usa, garante" evita isso.
- **Confiar na criação automática do broker:** é o que causou a espera; além disso depende da configuração de cada ambiente.
- **Só reduzir o refresh de metadados:** reduz a espera para segundos, mas não garante que o tópico exista antes da primeira publicação. Adotado apenas como rede de segurança.

### Consequências
- Um tópico pode ser criado por qualquer um dos serviços que o usam; vale quem chegar primeiro, por isso o padrão de partições deve ser igual.
- Em ambientes com a criação por administrador (ACL), o usuário do serviço precisa de permissão para criar tópicos, ou os tópicos devem ser criados antes por infraestrutura (a garantia então só confirma que existem).
- A lista de tópicos e quem produz/consome está em `docs/integration/contracts-with-team.md`.


## DT-06 — Certificados são emitidos somente a partir de eventos de presença

- **Estado:** Aceito (implementado em Certificados)
- **Data:** 2026-11-04
- **Resolve:** P9 de `docs/integration/contracts-with-team.md` (nome do participante)

### Contexto
O serviço de Certificados já tinha a regra de elegibilidade (presença mínima de 75% e atividade encerrada), o gerador de PDF e a persistência, mas nada os acionava. Faltava decidir **quem dispara a emissão**, **de onde vem o nome do participante** e **onde os PDFs ficam guardados**. Inscrições já publica `subscription.events` com um evento `AttendanceEligible` (pelo menos um check-in válido, emitido somente após o fim da atividade).

### Decisão
1. **Certificados só são criados ao consumir `AttendanceEligible` de `subscription.events`** (grupo `certificates-service`, confirmação manual do offset depois do processamento). **Não existe endpoint de criação.** Qualquer outro tipo de evento, inclusive desconhecido, é confirmado e ignorado.
2. **O serviço faz validações próprias, sem confiar cegamente no evento:** busca a atividade e o evento em Eventos (`GET /activities/{id}`, `GET /events/{id}`), exige que a atividade tenha terminado (`agora >= ends_at`), busca o nome do participante em Usuários e só então aplica a regra de elegibilidade. Como o evento não traz percentual e o critério de Inscrições é "ao menos um check-in válido", a regra recebe presença = 100.
3. **Idempotência:** `registration_id` é único; um evento repetido (entrega pelo menos uma vez) ou uma corrida de inserção resulta em sucesso, sem segundo certificado.
4. **Falhas:** mensagem inválida (JSON, ids, `schema_version != 1`), atividade ou usuário inexistente e inelegibilidade são **venenosas**: grava-se em `certificates.dlq` apenas uma referência (tópico, partição, offset, motivo, sem dados pessoais) e confirma-se o offset. Falha de dependência, atividade ainda não encerrada ou erro inesperado são **transitórios**: não confirma, volta ao mesmo offset e repete com espera crescente (2 s até 30 s). A thread do consumidor nunca encerra.
5. **Nome do participante** vem de um endpoint **interno e sem autenticação** de Usuários, `GET /internal/users/{id}`, que devolve **somente `id` e `name`**. A proteção é o isolamento de rede (como os demais `/internal/...`, ver DT-03); ele **nunca é registrado no Gateway**.
6. **Armazenamento dos PDFs** atrás de uma interface (`save_pdf`/`read_pdf`/`delete_pdf`, chaves opacas `<uuid>.pdf`) com dois backends: sistema de arquivos local (padrão em código e nos testes) e **S3 compatível (SeaweedFS no compose)**, escolhido por `CERTIFICATE_STORAGE_BACKEND`. O compose usa SeaweedFS (gateway S3 na porta 8333) privado, sem porta no host, com credenciais sem valor padrão, gravadas no arquivo de identidades S3 na inicialização do contêiner. O MinIO foi a primeira escolha, mas a imagem `minio/minio` deixou de ser publicada (a comunidade não recebe mais imagens oficiais, e o tag fixado não pode ser baixado); o SeaweedFS (`chrislusf/seaweedfs`) foi adotado por ser um armazenamento compatível com S3 e mantido. Como o acesso continua atrás da interface `BlobStorage`, o backend pode ser trocado sem mudar o domínio.
7. **API pública (atrás do Gateway):** apenas `GET /api/v1/certificates/me` e `GET /api/v1/certificates/{id}`. A identidade vem de `X-User-Id` (DT-03); o PDF só é entregue ao dono, e o de outro usuário responde `404` igual ao inexistente. Cada certificado guarda `user_id` e `activity_id` (migração nova, colunas anuláveis porque as linhas antigas não podem ser preenchidas).
8. Os tópicos `subscription.events` e `certificates.dlq` são garantidos pelo próprio serviço antes de consumir (DT-05).

### Alternativas rejeitadas
- **Endpoint HTTP de criação (chamado por Inscrições ou pelo front):** exigiria autorização de serviço a serviço, que não existe, e permitiria emitir sem presença válida; também acopla a disponibilidade de Certificados à de Inscrições.
- **Nome do participante dentro do evento:** espalha dado pessoal por um tópico retido e relido, e o nome pode mudar; o dono do dado é Usuários.
- **Busca de usuários (`GET /api/v1/users`):** exige token de organizador e expõe nome e e-mail, muito além do necessário (ver P18).
- **Confiar no evento sem consultar Eventos:** um evento adulterado ou antecipado emitiria certificado para atividade que não terminou.
- **Manter o PDF só em volume local:** não é compartilhável entre réplicas nem sobrevive à recriação do contêiner de forma explícita.

### Consequências
- Usuários precisa expor `GET /internal/users/{id}` e Eventos precisa expor `GET /activities/{id}` e `GET /events/{id}` (contrato em `docs/integration/contracts-with-team.md`).
- O endpoint interno depende do isolamento de rede: um contêiner dentro da rede pode consultar o nome de qualquer usuário pelo id. Risco aceito, restrito a `id` e `name`.
- Uma mensagem que depende de serviço indisponível é repetida indefinidamente e bloqueia a partição atrás dela; prioriza-se não perder um certificado.
- (Superado em 2026-11-05, ver abaixo) O percentual de presença fixo em 100 deve ser revisto se Inscrições passar a enviar um percentual.
- Em ambientes que não sejam de desenvolvimento, o armazenamento S3 deve usar chave de acesso própria, não a raiz.

### Atualização 2026-11-05 — presença por evento, um certificado por (usuário, evento)

**Decisão do time:** a regra de presença (RN06, mínimo de 75%) diz respeito a um **evento**, não a uma atividade. Substitui os itens 2 e 3 da decisão acima e a consequência do percentual fixo em 100.

1. **O percentual é por evento e calculado por Inscrições**, que emite `AttendanceEligible` **somente quando a regra é atendida**, **uma vez por usuário e evento**, depois do fim da última atividade confirmada do evento. O envelope ganha `event_id`, `attended_activities`, `total_activities` e `attendance_percentage` (`attended*100/total`, 2 casas); `registration_id` e `activity_id` são os da inscrição que disparou.
2. **Certificados reverifica, sem confiar cegamente:** valida o contrato (UUID, inteiros sem booleanos, `total >= 1`, `0 <= attended <= total`, percentual finito), confere que o percentual é consistente com as contagens (tolerância de 0,01) e aplica o **próprio limiar de 75%** em `is_eligible`. Violação de contrato vai para a DLQ com `INVALID_CONTRACT`; percentual abaixo do limiar (por exemplo de um produtor adulterado ou mal configurado) vai com `NOT_ELIGIBLE`. A constante fixa em 100 foi removida.
3. **Consultas:** só `GET /events/{event_id}` em Eventos (título, `starts_at`, `ends_at`); `GET /activities/{id}` deixou de ser usado. O evento deve ter terminado (`agora >= ends_at`), senão a mensagem é repetida. O PDF usa o título do evento e a data de `starts_at` no próprio fuso.
4. **Idempotência por dois eixos:** existe no máximo um certificado por `registration_id` e **um por (`user_id`, `event_id`)**, com índice único (migração `9e4a6b2c1d83`; `event_id` anulável porque os certificados antigos, por atividade, não podem ser preenchidos, e NULLs não colidem). Antes de qualquer consulta, um certificado já existente para um dos dois eixos é sucesso (**a primeira conclusão vence**); uma corrida de inserção é relida pelas duas chaves e também vira sucesso. `GET /api/v1/certificates/me` passa a devolver `event_id`.

**Limitação:** Certificados não consegue recontar os check-ins por conta própria (a fonte é Inscrições). Após a checagem de consistência entre percentual e contagens, ele confia nas contagens recebidas; a reverificação protege contra eventos malformados, inconsistentes ou abaixo do limiar, não contra um produtor que minta de forma coerente.

### Atualização 2026-11-05 (2) — mensagens antecipadas e evento cancelado

**Decisão:** Mensagens antecipadas são estacionadas no banco do próprio serviço até `ends_at` do evento; evento cancelado vai para a DLQ com `EVENT_CANCELLED`. Substitui o item 3 da atualização anterior (evento não encerrado = mensagem repetida) e corrige a consequência que dizia que o consumidor repete indefinidamente: isso continua valendo apenas para falha de dependência (Eventos, Usuários, armazenamento).

1. Inscrições emite `AttendanceEligible` quando termina a última **atividade** confirmada da pessoa, o que pode ocorrer dias antes do fim do **evento**; portanto a mensagem antecipada é um caso normal, não um desvio de relógio. Repeti-la no lugar travava a partição inteira (e para sempre, com evento cancelado).
2. Se o evento ainda não terminou, o consumidor grava a mensagem em `pending_attendance` (migração `b3f5a7d9c1e2`; `registration_id` é chave primária, então estacionar duas vezes é inofensivo; guarda também tópico, partição e offset de origem) com `not_before = ends_at` e **confirma o offset**. Nada bloqueia.
3. Um agendador em segundo plano (a cada 30 s, `FOR UPDATE SKIP LOCKED` no PostgreSQL para várias réplicas) reprocessa as linhas vencidas com a **mesma** lógica do consumidor. Sucesso ou já emitido apaga a linha; mensagem venenosa vai para a DLQ com a referência de origem guardada e apaga a linha; evento que ainda não terminou (relógio ou fim adiado) reagenda para o maior entre o `ends_at` atual e agora + 60 s; outra falha transitória mantém a linha com `attempts + 1` e espera `min(30 s * 2^tentativas, 15 min)`, atrasando só aquela linha.
4. Eventos devolve `status` (`DRAFT`, `PUBLISHED`, `CANCELLED`) em `GET /api/v1/events/{event_id}`, e a resposta sem `status` é inválida (transitória). `CANCELLED`, verificado **antes** da checagem de término, é venenosa (`EVENT_CANCELLED`): um evento cancelado nunca gera certificado, mesmo que o `ends_at` já tenha passado. Os demais status se comportam como antes.


## DT-07 — Frontend: sessão em memória e pilha

- **Estado:** Aceito
- **Data:** 2026-11-04

### Contexto
O serviço de Usuários emite um Access Token JWT (30 min) e o Gateway o valida. Não existe refresh token nem cookie `HttpOnly`. Guardar o token em `localStorage`/`sessionStorage` o deixaria legível por qualquer script injetado (XSS), e o prompt do projeto proíbe persistir token no navegador.

### Decisão
- **O Access Token vive somente em memória** (variável fechada em `createServices`), nunca em `localStorage`, `sessionStorage`, `IndexedDB` ou cookie. Consequência aceita: **recarregar a página exige novo login**; não há "lembrar de mim".
- A sessão termina em três casos: logout, expiração (temporizador pelo `expiresIn`) e **qualquer 401 numa chamada autenticada**. O 401 do próprio login não encerra nada (é só "credenciais inválidas"), o que evita laços de redirecionamento.
- O cliente HTTP central é o único ponto que monta `Authorization`, usa `credentials: 'omit'` e `cache: 'no-store'`.
- Rotas protegidas no cliente (`RequireAuth`, `RequireRole`) são só experiência de navegação: **o backend autoriza** (401/403), e a interface exibe o que ele decidir.
- Toda resposta é validada com Zod (`INVALID_RESPONSE` se fugir do contrato) e um teste compara esses schemas e as rotas chamadas com `docs/api/users.openapi.yaml`.
- A URL do Gateway vem de `VITE_API_BASE_URL` (valor público no bundle, sem segredos); os caminhos das APIs ficam em `src/config.ts`.
- ESLint proíbe `console.*`, `localStorage` e `sessionStorage`; um teste varre o código (sem comentários) atrás de IPs, `localhost`, URLs absolutas e `Authorization` fora do cliente.

### Pilha e versões (verificadas no npm em 2026-11-04, instaladas e executadas)
React 19.3.1, React Router 8.5.1, Vite 8.3.5 (+ plugin-react 6.2.1), **TypeScript 6.0.3**, Vitest 5.1.0 + Testing Library (react 16.3.3, user-event 14.6.8) + jsdom 30.1.3, React Hook Form 7.91.0 + `@hookform/resolvers` 7.0.2 + Zod 4.6.7, ESLint 10.14.0 + typescript-eslint 8.72.1, Prettier 3.9.10. Node: `^20.19 || >=22.12`.

O TypeScript 7.0.2 já existe, mas o `typescript-eslint` 8.72.1 declara `typescript >=4.8.4 <6.1.0`; ficamos no 6.0.3 até o lint suportar o 7. O `@hookform/resolvers` só é necessário para ligar o Zod ao React Hook Form.

### Alternativas
- Token em `sessionStorage`: sobrevive ao recarregar, mas fica exposto a XSS; rejeitado.
- Cookie `HttpOnly` com refresh token: o correto para persistir, mas exige mudança no backend e no Gateway; fora do escopo.
- MSW nos testes: descartado; um `fetch` falso por rotas basta e evita mais uma dependência.

### Consequências
Experiência: recarregar a página desloga. Segurança: o token não sobrevive a XSS persistente nem a abas compartilhadas. Esta ADR deve ser revista se o backend passar a oferecer refresh token em cookie `HttpOnly`.


## DT-08 — Frontend da aplicação inteira: escopo por fases e decisões da fase A1

- **Estado:** Aceito
- **Data:** 2026-11-05

### Contexto
O frontend nasceu só com Usuários (ADR-006). Desde então os outros serviços ganharam API real; inventário em 2026-11-05:

| Serviço | API para o frontend | Fonte do contrato |
|---|---|---|
| Eventos | catálogo público, detalhe, atividades, CRUD do organizador, publicar/cancelar, encerrar atividade | `events/src/http/schemas.ts`, `routes.ts` |
| Inscrições | criar, vagas, listar, cancelar, aceitar oferta, participantes, check-in | `subscription/app/api.py` |
| Pagamentos | consultar pagamento, simular (demonstração) | `payments/README.md` |
| Notificações | listar, marcar como lida, WebSocket | `README.md` raiz |
| Relatórios | métricas do organizador | `reports/README.md` |
| Certificados | lista e PDF do dono (`/certificates/me`, `/certificates/{id}`) | `docs/integration/contracts-with-team.md` §4c |

Todos declaram as configurações de Gateway (`x-gateway`: público ou não, `requireAuth`) no próprio OpenAPI.

### Decisão: fases
Cada fase conecta somente endpoints com contrato e é entregue com testes.
- **A1 (esta):** shell com menu, Início, catálogo e detalhe de Eventos, inscrição por atividade, Minhas inscrições.
- **A2 (entregue):** área do organizador: meus eventos (criar, editar, publicar, cancelar), atividades, participantes e check-in.
- **B (entregue):** Pagamentos (situação da cobrança) e Notificações (lista, marcar como lida, tempo real).
- **C (entregue):** Relatórios do organizador e Certificados (lista e download do PDF).

### Decisões da fase A1
1. **O catálogo é público e chamado sem token.** As leituras públicas de Eventos são `requireAuth=false`, e uma sessão expirada não deve quebrar a navegação.
2. **Erros de Eventos e Inscrições são traduzidos pelo código** (`CODE_MESSAGES`). Eventos responde em inglês e Inscrições manda só o código em `title`, sem `detail`. Mensagens de campo desses serviços viram "Valor inválido."; nada técnico chega à tela. O serviço de Usuários segue mostrando a mensagem em português do próprio servidor.
3. **Vagas livres vêm de Inscrições, não de Eventos.** Eventos guarda só a capacidade; Inscrições é o único contador (`GET /activities/{id}/availability`, que exige login). Autenticado: "12 de 30 vagas". Visitante, ou se a consulta falhar: "30 vagas no total", e o servidor decide na hora da inscrição.
4. **Botão de inscrição, em ordem:** já inscrito → mostra a situação; `registration_open=false` → mensagem pelo `lifecycle` ("Atividade cancelada/encerrada" ou "Inscrições encerradas"); visitante → "Entre para se inscrever"; sem vagas e com lista de espera → "Entrar na lista de espera" (`join_waitlist=true`); sem vagas e sem lista → "Esgotado"; senão "Inscrever-se" (`join_waitlist=false`: nunca entra em fila sem a pessoa pedir). Se o servidor responder `ACTIVITY_FULL` (as vagas acabaram depois de a página carregar), a tela passa a oferecer a lista de espera.
5. **Nomes das atividades em "Minhas inscrições"** vêm de Eventos (`GET /activities/{id}`), uma chamada por atividade distinta, com `allSettled`: se Eventos falhar, a inscrição aparece com identificação curta.
6. **Datas:** Inscrições serializa com `str(datetime)` do Python ("2026-11-03 23:25:45+00:00"); `normalizeApiDate` converte para ISO. O V8 aceita o formato com espaço e o Safari não, por isso há teste direto da função.
7. **Início (`/inicio`) é o destino pós-login.** Visitantes chegam ao catálogo (`/`). O menu mostra só o que existe. Banner de evento só com URL `https`, sem referrer.
8. **Rastreio:** o Gateway e os serviços usam `X-Trace-Id` (antes `X-Request-Id`, ainda aceito como fallback). A mensagem de erro mostra o `traceId` do corpo quando existe.

### Decisões da fase A2 (área do organizador)
1. **Só o papel ORGANIZER vê a área** (`/organizador/...`, menu "Meus eventos"). É só experiência de navegação: quem autoriza é o serviço (dono do evento; Eventos responde 403/404 a outro usuário).
2. **Rascunho exige token na leitura.** `getEvent` aceita `auth: true`; a página de gestão o usa, porque Eventos só mostra rascunho ao dono. O catálogo público continua sem token.
3. **A interface espelha as regras que o serviço aplica, mas o serviço decide:** evento cancelado não edita nem recebe atividade; atividade encerrada/cancelada não edita; **capacidade é imutável** (campo só leitura e nunca enviado no PATCH); **preço só muda em rascunho** (campo só leitura depois); **remover atividade só em rascunho**; **encerrar só depois do término previsto**; publicar exige ao menos uma atividade (a mensagem do serviço é traduzida). Toda ação destrutiva (cancelar evento, remover atividade) pede confirmação.
4. **Formulários em texto, conversão na saída:** datas `datetime-local` (horário local) viram ISO 8601 em UTC; o preço em reais vira `amount_minor` por aritmética de texto (sem ponto flutuante); campos opcionais vazios viram `null`. Banner só `https`.
5. **Participantes:** `GET /activities/{id}/registrations` (organizador) + nome/e-mail por busca de usuários por id. Se a busca falhar, mostra o id curto. O check-in só é oferecido a inscrição `CONFIRMED` durante a atividade; o serviço devolve 409 fora disso (traduzido).

### Decisões da fase B (Pagamentos e Notificações)
1. **Pagar parte de "Minhas inscrições":** só inscrição `PENDING_PAYMENT` tem "Pagar". O cliente envia **apenas** `registration_id` a `POST /payments/payments`; valor, moeda e dono vêm de Inscrições. A criação é idempotente, então voltar à tela devolve o mesmo pagamento.
2. **Tela do pagamento (`/pagamentos/:id`):** mostra valor, situação, prazo e o que aconteceu com a vaga. Enquanto `PENDING`, consulta a cada 4 s e para ao chegar a um estado final (a aprovação chega por Kafka, de forma assíncrona). Depois de aprovado, a inscrição pode levar instantes para constar como confirmada, e a tela diz isso.
3. **Provedor simulado:** os botões aprovar/recusar/expirar só aparecem com o pagamento pendente e são rotulados como demonstração. Se o serviço o desligar (`SIMULATOR_ENABLED=false`), responde 404 e a tela mostra a mensagem traduzida. `409 PAYMENT_NOT_APPLIED` recarrega o estado real.
4. **Notificações em tempo real pelo WebSocket do Gateway** (`GET /ws?access_token=…`). O navegador não envia cabeçalho em WebSocket, então o token vai na query; o Gateway não registra a query, mas **isso exige TLS em produção** e token de vida curta. Há uma conexão por usuário (a mais nova vence): o código `4000` (substituída por outra aba) **não** reconecta, para duas abas não se derrubarem; qualquer outra queda reconecta com espera crescente (1 s … 30 s). Quadros desconhecidos ou inválidos são ignorados. Como reserva, o contador é consultado a cada 30 s.
5. **Contador do menu:** não lidas = status `DEFAULT` ou `RECEIVED` (até 100; mostra "100+"). Um push é contado uma vez por id, e uma consulta em andamento é descartada se um push chegar no meio (o resultado dela é anterior a ele).
6. **Links das notificações só para destinos internos conhecidos,** montados do `payload` (`payment` com `payment_id` UUID → `/pagamentos/:id`; tipos `Registration*`/`Waitlist*` → `/inscricoes`). O `redirect_url` do serviço **não é usado**: nenhum produtor o preenche hoje e um endereço vindo de fora não deve virar link.
7. **Marcar como lida** usa `PUT /notifications/update-state` (lote ≤ 100). Resposta parcial (`errors`) é tratada: só o que foi atualizado muda na tela e a falha é informada.

### Decisões da fase C (Relatórios e Certificados)
1. **Relatório (`/organizador/eventos/:id/relatorio`)** usa `GET /reports/events/{id}/summary` e a lista paginada `…/activities`. O link só aparece para evento **não rascunho** (rascunho não tem indicadores). Quem não é dono recebe 404 `EVENT_NOT_FOUND` do serviço e a tela mostra "não encontrado" (o serviço não distingue inexistente de alheio, e a tela também não).
2. **Os números são eventualmente consistentes:** o serviço de Relatórios monta um modelo de leitura a partir do Kafka. A tela tem "Atualizar" e avisa que podem atrasar em relação às outras telas.
3. **Dinheiro nunca é somado entre moedas:** valores são inteiros em unidades menores, exibidos por moeda (`Intl` pt-BR); moeda desconhecida (`UNKNOWN`) aparece como "15,00 UNKNOWN" em vez de quebrar. Zero é um valor, não ausência.
4. **Taxas** (0–1) viram "75,0%"; `null` (denominador zero) vira "—", nunca "0%".
5. **Certificados (`/certificados`)** lista `GET /certificates/api/v1/certificates/me` (página de 50; "Próxima" só quando a página veio cheia, pois o serviço não devolve total). O título do evento vem do catálogo público; `event_id` nulo (certificados antigos) mostra identificação curta. Não há botão de emitir: o certificado nasce de `AttendanceEligible` (evento encerrado e ≥ 75% de presença), e o estado vazio explica isso.
6. **Download do PDF exige Bearer**, então um link `<a href>` não serve: o cliente baixa por `fetch` como Blob (`requestBlob`, que exige `Content-Type: application/pdf`, senão `INVALID_RESPONSE`) e salva como `certificado-<id>.pdf` por um endereço temporário liberado logo em seguida. 404 vira "não encontrado"; 503 (arquivo ainda indisponível) é traduzido.

### Detecção de divergência de contrato
Testes leem o **código-fonte** dos serviços (rotas de Eventos, com o prefixo `API`, e de Inscrições; nomes dos serviços no Gateway) e conferem que toda rota que o cliente chama existe. Isso já se pagou: depois de atualizar o `main`, Eventos passou a servir tudo sob `/api/v1`, renomeou `id`→`event_id`/`activity_id`, `price_cents`→`amount_minor` e removeu `available`; o teste acusou na hora, e o cliente foi reescrito antes de entregar.

### Consequências
- **P21 (Inscrições × Eventos) está resolvida no código:** Eventos agora implementa `GET /api/v1/activities/{id}` e `/permissions/me` no formato que Inscrições consome. **Não foi validada de ponta a ponta** (sem Docker no ambiente de desenvolvimento): a inscrição só foi testada com respostas simuladas.
- A interface depende do contrato atual de Eventos; mudanças nele quebram os testes de contrato antes de quebrar a tela.


## DT-09 — Inscrições é declarativa; Pagamentos reage aos eventos

- **Estado:** Aceito (implementado em Inscrições; Pagamentos adota o mesmo contrato)
- **Data:** 2026-11-05

### Contexto
Inscrições dava ordens a Pagamentos: publicava comandos em `payments.commands` (`PaymentRequested`, `PaymentCancelRequested`, `PaymentRefundRequested`), mantinha uma tabela local de tentativas financeiras (`payment_attempts`) com versão do provedor, chave de idempotência e um job de reconciliação que consultava `GET /internal/payment-attempts/{id}` em Pagamentos. Isso acoplava os dois serviços: Inscrições precisava conhecer o ciclo de vida financeiro (cancelamento pendente, estorno pendente), e Pagamentos precisava guardar e expor um histórico versionado só para Inscrições reconciliar. Inscrições já publica eventos de domínio completos em `subscription.events`, suficientes para Pagamentos decidir sozinho.

### Decisão
1. **Inscrições é declarativa:** só emite eventos de domínio e não envia comandos nem chama Pagamentos. Entrou em `PENDING_PAYMENT` (inscrição paga ou aceite de oferta paga) emite o novo `RegistrationPendingPayment`, sem campos extras.
2. **Pagamentos reage:** consome `subscription.events`, cancela a cobrança pendente ou estorna a aprovada ao ver `RegistrationCancelled`/`RegistrationExpired`. Ignora `RegistrationPendingPayment`: a cobrança não nasce de evento.
3. **Criação via HTTP com consulta:** a cobrança é criada por `POST /payments` (só com o `registration_id`; a identidade vem de `X-User-Id`). Pagamentos lê os fatos (atividade, valor, moeda, prazo, evento, estado) em `GET /internal/registrations/{registration_id}` de Inscrições, rota interna sem autenticação (isolamento de rede), fora do OpenAPI e do Gateway. Para servir o evento, a inscrição passa a gravar o id do evento (migração `004`, coluna `parent_event_id`, renomeada para `event_id` na `006`).
4. **Pagamentos tem a própria expiração** da cobrança, independente da de Inscrições.
5. **Sem reconciliação:** removidos `payments.commands`, `payment_attempts` (migração `004` a elimina), `idempotency_key`, `payment_attempt_id`, `provider_version`, o job de reconciliação e `RECONCILE_SECONDS`.
6. **Inscrições aplica regras sobre `payments.events`** (deduplicado por `message_id`, campos extras ignorados): `PaymentApproved` confirma só se a inscrição está `PENDING_PAYMENT`, dentro da reserva (relógio do banco) e com valor/moeda iguais ao snapshot, senão é ignorado; `PaymentDeclined` rejeita e promove a fila; `PaymentCreated`, `PaymentExpired`, `PaymentCancelled` e `PaymentRefunded` são informativos; `registration_id` desconhecido é ignorado.

### Alternativas
- **Manter comandos e reconciliação:** funciona, mas mantém o acoplamento e duas fontes do estado financeiro.
- **Incluir valor, moeda e prazo no evento `RegistrationPendingPayment`:** dispensaria o HTTP, mas congela o formato do evento para o consumo de Pagamentos; a consulta devolve sempre o estado atual.
- **Eventos como única fonte, sem endpoint:** exigiria que Pagamentos reconstruísse o estado das inscrições a partir de todo o histórico.

### Consequências
- Uma aprovação tardia (depois de cancelamento, expiração ou fora do prazo) não confirma nada em Inscrições; Pagamentos a estorna por conta própria depois de ver o evento de cancelamento/expiração.
- O timer de reserva de Inscrições é a autoridade sobre a vaga; os eventos de expiração/cancelamento de Pagamentos não liberam vaga.
- Pagamentos passa a depender da disponibilidade do endpoint interno de Inscrições para criar cobranças, e do isolamento de rede como única proteção dele.
- Não há endpoint de reconciliação financeira: uma mensagem de `payments.events` perdida não é recuperada por consulta. A garantia de entrega é a da outbox/Kafka (pelo menos uma vez); uma aprovação perdida deixa a inscrição expirar pelo timer e Pagamentos estorna.
- Inscrições deixa de expor `payment.status` na leitura individual da inscrição.


## DT-10 — Eventos encerra atividades e segue o contrato de Inscrições

- **Estado:** Aceito (implementado em Eventos e Inscrições)
- **Data:** 2026-11-05

### Contexto
Eventos e Inscrições tinham modelos de vagas e contratos incompatíveis: Eventos reservava assentos (saga de reserva por Kafka, `reserved`, `seat_reservations`), validava o JWT por conta própria e usava nomes e formatos próprios (`id`, `price_cents`, rotas sem `/api/v1`), enquanto Inscrições contava as vagas, confiava nos cabeçalhos do Gateway e esperava `activity_id`, `event_id`, `amount_minor`+`currency` e um envelope plano. Além disso, os certificados nunca eram emitidos porque nada encerrava uma atividade: Inscrições só avalia presença quando recebe `ActivityEnded`, e ninguém o publicava.

### Decisão
1. **Eventos guarda só a capacidade máxima e Inscrições conta as vagas.** Eventos não reserva assentos e não consome Kafka.
2. **Eventos publica `ActivityEnded`/`ActivityCancelled` em `events.events`.** O encerramento manual é feito pelo organizador via `POST /api/v1/activities/{activity_id}/end`, somente depois de `ends_at`; o automático ocorre após `ACTIVITY_AUTO_END_AFTER_SECONDS` (padrão 86400) do `ends_at`. O cancelamento de um evento cancela suas atividades.
3. **Identidade só por `X-User-Id`/`X-User-Roles`,** sem validar JWT em Eventos (o `Authorization` é ignorado), como nos demais serviços atrás do Gateway (DT-03).
4. **Nomes e formato seguem Inscrições:** prefixo `/api/v1`, `activity_id`/`event_id`, `amount_minor`+`currency`, e envelope plano com `message_id`, `schema_version`, `type` PascalCase, `occurred_at` e `trace_id`. Eventos também publica `EventCreated`, `EventUpdated`, `EventPublished`, `EventCancelled`, `ActivityCreated`, `ActivityUpdated` e `ActivityDeleted`; a chave é `activity_id` em `ActivityEnded`/`ActivityCancelled` e `event_id` nos demais. Inscrições trata só os dois tipos de ciclo de vida, ignora os outros (confirmados sem DLQ) e ignora campos extras na resposta de `GET /api/v1/activities/{activity_id}`.

### Alternativas
- **Manter a saga de reserva em Eventos:** duas fontes de verdade para as vagas e um contrato Kafka a mais para manter em sincronia com Inscrições.
- **Inscrições derivar o fim da atividade de `ends_at`:** esconderia o encerramento em um relógio de Inscrições, sem permitir ao organizador encerrar nem publicar o fato para outros consumidores (Certificados, Relatórios).

### Consequências
- Relatórios ainda lê o formato antigo de Eventos e deixa de projetar eventos/atividades até ser adaptado.
- Certificados passa a ler `event_id`.
- As colunas legadas `reserved` e a tabela `seat_reservations` permanecem sem uso em Eventos.
- Inscrições passa a receber todos os tipos de `events.events`; um novo tipo publicado por Eventos não exige mudança em Inscrições nem gera DLQ, mas só `ActivityEnded`/`ActivityCancelled` têm efeito.


## DT-11 — Papel ADMIN e pedido de organizador

- **Estado:** Aceito (substitui a parte de "como se cria um organizador" do DT-02; resolve P7)
- **Data:** 2026-11-11

### Contexto
O DT-02 deixava o papel `ORGANIZER` sem fluxo de produção: só o seed de desenvolvimento criava um. O teste de ponta a ponta de 2026-11-11 mostrou o problema na prática: ninguém consegue demonstrar a área do organizador sem mexer no banco ou no ambiente. A equipe pediu: o **cadastro permite escolher o papel**; quem escolhe "organizador" **não ganha o papel na hora**; uma **tela de administração lista todos os usuários, identifica quem pediu para ser organizador** e o administrador **concede ou nega**.

### Decisão
1. **Cadastro (`POST /api/v1/auth/register`)** aceita o campo opcional `requestedRole` (`PARTICIPANT`, padrão, ou `ORGANIZER`). Qualquer outro valor (inclusive `ADMIN`) é `400`. A conta nasce **sempre só com `PARTICIPANT`**; com `ORGANIZER` ela recebe `organizerRequest = PENDING`. Campos como `roles` e `isAdmin` continuam rejeitados (`400 MALFORMED_REQUEST`).
2. **Pedido de organizador** (`organizerRequest`): `NONE` (nunca pediu), `PENDING` (aguarda), `APPROVED` (um ADMIN concedeu), `DENIED` (um ADMIN negou ou retirou). Fica em colunas novas de `users` (migração `V2`); quem já era organizador antes da migração vira `APPROVED`.
3. **Papel `ADMIN`** (novo em `user_roles`). **Nenhuma rota HTTP concede ADMIN.** O primeiro administrador vem de `USERS_ADMIN_BOOTSTRAP_*` (desativado por padrão, credenciais só do ambiente, idempotente, conta com **apenas** `ADMIN`). Administrador não é organizador nem participante: ele administra.
4. **Rotas do ADMIN** (`/api/v1/admin/**`, exigem `hasRole("ADMIN")` na cadeia de segurança **e** conferem o papel no banco de novo, como a busca de usuários):
   - `GET /api/v1/admin/users?q&organizerRequest&page&size`: lista todos (sem exigir filtro), com a situação do pedido; `q` procura em nome e e-mail; máx. 50 por página; nunca devolve hash de senha.
   - `PUT /api/v1/admin/users/{id}/organizer` com `{"approved": true|false}`: concede `ORGANIZER` ou nega o pedido/retira o papel. **Idempotente.** Administradores não são alvo (`409 ADMIN_TARGET_NOT_ALLOWED`); aprovar conta inativa é recusado.
5. **O papel só vale no token depois de um novo login.** O JWT carrega `roles` e dura 30 min (DT-01/DT-07); não há refresh. Consequências aceitas: (a) quem foi aprovado precisa **sair e entrar de novo** (o perfil e a tela do administrador avisam); (b) quem teve o papel retirado mantém o token antigo até ele expirar em **outros serviços** que confiam nas claims. No serviço de Usuários a conferência no banco vale na hora (a busca de usuários passa a dar `403`).
6. **Auditoria:** novas operações `ADMIN_USER_LIST`, `ORGANIZER_GRANTED` e `ORGANIZER_DENIED`, só com ids (quem agiu e sobre quem), sem dados pessoais.
7. **Frontend:** o cadastro tem "Tipo de conta" (Participante/Organizador, nunca Administrador) e avisa que o pedido aguarda aprovação; `/admin/usuarios` (só ADMIN, menu "Administração") tem busca, filtros (Todos, Aguardando aprovação, Aprovados, Negados, Sem pedido), **Aprovar**, **Negar** (só pedido pendente) e **Retirar papel** (com confirmação). O perfil mostra a situação do pedido. Esconder telas é só experiência: o servidor recusa o que não é permitido.
8. **Limites do Gateway (E1 do relatório de testes):** `@GatewaySettings` ganhou `maxPerMin` e `rateLimitBy`, publicados no `x-gateway`. Login e cadastro: **10/min por IP**; `users/me` 120 e 30; busca 60; rotas de admin 60 e 30. O Gateway só semeia rotas novas (P24): num banco do Gateway **já populado**, aplicar com `user/scripts/register-gateway-routes.sh` ou `PUT /admin/endpoints`.

### Alternativas
- **Promoção por qualquer organizador:** simples, mas um organizador comprometido vira ponto de escalada.
- **Auto-declaração no cadastro:** inseguro (DT-02).
- **Só o seed:** sem fluxo de produção.
- **ADMIN criado por rota HTTP:** criaria um caminho de escalada de privilégio; ficou só o bootstrap por ambiente.

### Consequências
- Primeiro uso: definir `USERS_ADMIN_BOOTSTRAP_ENABLED=true` com nome, e-mail e senha no `.env`, subir o serviço, entrar como administrador e aprovar quem pediu. Depois, desligar o bootstrap.
- **Validado:** `./mvnw verify` da equipe em 2026-11-11 passou (53 unitários e 47 integrações, incluindo `AdminFlowIT`, `AdminBootstrapIT` e `MigrationIT`). **Não validado:** o fluxo no navegador contra o stack completo.
- Não há tela para rebaixar um administrador nem para criar outro: é operação de banco/ambiente.
