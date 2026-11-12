# Relatório de testes

Execução mais recente e completa (todos os serviços, pilha no ar, falhas e concorrência): [`../evidence/resultados.md`](../evidence/resultados.md), de 12/11/2026,
com logs em `../evidence/logs/`. Este arquivo guarda o histórico detalhado do serviço de Usuários e do frontend.

## Execução 4 — 2026-11-12 (máquina da equipe, Docker Compose)
- `./mvnw verify` do serviço de Usuários: **BUILD SUCCESS**, 53 testes unitários e 47 de integração, 0 falhas e 0 ignorados. Isso encerra as pendências
  "re-execução pendente" da Execução 2 e "pendente" da Execução 3 (busca de usuários, administração e pedido de organizador).
- Frontend: 297 testes, lint, tipos e build limpos.
- Os itens da seção "Ainda não executado" abaixo (imagem Docker, `docker compose up`, fluxo real pelo Gateway, registro no service-discoverer) **foram
  executados**: os 18 containers subiram, `scripts/demo-seed.sh` terminou em `CONFIRMED` e as falhas A, B e C se comportaram como esperado. Ficaram sem
  execução com a pilha: queda do Kafka, espera real do prazo de 900 s e carga/pico.

# Histórico do serviço de Usuários

## Execução 2 — `./mvnw verify` na máquina da equipe (2026-10-31, 15:00 -03)
**Ambiente:** Ubuntu 24.04, JDK 21.0.12, Docker 29.9.0 (Server API 1.56), Testcontainers 2.0.5, `postgres:16-alpine` (PostgreSQL 16.15), Spring Boot 4.1.1, Hibernate 7.4.5, Spring Security 7.1.1, springdoc 3.0.3.

| Fase | Resultado |
|---|---|
| Compilação (30 fontes main, 15 test) | **OK** |
| `*Test` (surefire, sem Docker) | **26/26 aprovados** (após corrigir a asserção do `iss`, ver abaixo) |
| `*IT` (failsafe, PostgreSQL real) | **22/23 aprovados; 1 erro no próprio teste** (corrigido e reexecutado na Execução 4) |

Passaram nos `*IT`: `InfraEndpointsIT` (3: healthcheck, `/openapi.json`, JWKS), `MigrationIT` (5), `NoSeedByDefaultIT` (1), `DevSeedIT` (1) e 12 dos 13 de `AuthFlowIT`, incluindo cadastro/duplicidade, campos privilegiados rejeitados, 8 cadastros concorrentes do mesmo e-mail (1 criado e 7 `409`, nenhum `500`), login genérico, perfil próprio, PATCH restrito, `X-Request-Id`, erros sem vazamento e logs sem senha/token.

### Falhas encontradas e tratamento
| # | Onde | Causa | Correção |
|---|---|---|---|
| 1 | `TokenServiceTest.issuesDocumentedClaimsOnly` | Bug do **teste**: o Spring Security 7 converte `jwt.getIssuer()` para `URL`, e o `iss` é a string `eventhub-users`. | Asserção trocada por `jwt.getClaimAsString("iss")`. Reexecutado: 26/26. |
| 2 | `AuthFlowIT.meRejects...` | Bug do **teste**: o JWK da chave "estrangeira" não tinha `kid`, então o `NimbusJwtEncoder` não o selecionou ("Failed to select a JWK signing key") e o cenário nem chegou ao serviço. | O JWK estrangeiro recebe o mesmo `kid` do serviço (cenário mais exigente: kid forjado, assinatura de outra chave). **Re-execução pendente.** |

### Achado de segurança/privacidade (corrigido, a confirmar)
Na duplicidade de e-mail o Hibernate registrava em WARN `Key (email)=(...) already exists`, ou seja, **e-mail em claro nos logs**, o que contraria a diretriz de minimizar dados pessoais. Os testes de log só verificavam senha e token e não pegaram isso. Correção: `logging.level.org.hibernate.orm.jdbc.error=ERROR` (o conflito continua auditado com `emailFingerprint`). Confirmar na próxima execução que a linha `HHH000247` não aparece.

### Observações
- `SpringDoc /openapi.json endpoint is enabled by default`: esperado, pois o Gateway precisa ler esse endpoint; ele não é aberto no Gateway público (nasce privado).
- Avisos do Mockito/ByteBuddy (agente dinâmico): inofensivos hoje; podem exigir configuração em JDKs futuros.

## Execução 3 — busca de usuários (`GET /api/v1/users`) — aprovada na Execução 4
Código e testes escritos (`UserServiceTest` +3, `UserSpecificationsTest`, `UserSearchIT` com 8 casos, `InfraEndpointsIT` e `AuthFlowIT` ajustados), mas **ainda não executados**. Registrar aqui o resultado do próximo `./mvnw verify`. Pontos de atenção na primeira execução: API de `Specification` do Spring Data JPA 4.x, `like(..., escape)` no PostgreSQL e o tratamento de `MethodArgumentTypeMismatchException`.

## Execução 1 — sandbox sem Maven Central (2026-10-31, antes da execução 2)
Verificações parciais, todas aprovadas: migração e 11 cenários de constraint no PostgreSQL 16 (`src/test/sql/constraints.sql`), `PemKeys` com chaves do `openssl` (5 cenários), OpenAPI estático válido (`swagger-parser`), YAML dos composes e scripts. Substituída pela execução 2, que cobre compilação e testes completos.

## Ainda não executado (atualizado na Execução 4: só o que está listado na seção 'Execução 4')
- Build da imagem Docker do serviço e `docker compose up` com `user`, `user-db`, discoverer e Gateway.
- `user/scripts/register-gateway-routes.sh` e o fluxo real pelo Gateway.
- Registro real no `service-discoverer` (`USERS_DISCOVERY_ENABLED=true`): desativado nos testes.
- Carga/pico.

## Como reproduzir
```
(cd service-discoverer/Libs/java && ../../../user/mvnw -f pom.xml install -DskipTests)   # ou: mvn install -DskipTests
cd user && ./mvnw verify          # *Test + *IT (exige Docker)
./mvnw test                       # só *Test
```

---

# Relatório de testes — frontend

## Execução (2026-11-04, sandbox Linux, Node 22.22, npm registry acessível)
| Verificação | Comando | Resultado |
|---|---|---|
| Formatação | `npx prettier --check .` | **OK** |
| Lint (ESLint 10, regras de hooks e sem console/localStorage) | `npx eslint .` | **0 problemas** |
| Tipos (TypeScript 6.0.3, `strict` + `noUncheckedIndexedAccess`) | `npx tsc --noEmit` | **OK** |
| Testes | `npx vitest run` | **89/89 aprovados** em 10 arquivos |
| Build de produção | `npm run build` | **OK**: 401 kB de JS (125 kB gzip), 4 kB de CSS |
| Segredos no bundle | `grep` por senha/token de teste e `password_hash` | nenhum |

### Verificação de que os testes pegam defeitos (mutação manual)
Cada falha foi introduzida isoladamente e revertida:
| Falha introduzida | Testes que quebraram |
|---|---|
| 401 deixa de encerrar a sessão | 2 |
| `Authorization` não é enviado | 5 |
| rota protegida deixa passar visitante | 6 |
| token gravado em `localStorage` | 1 (varredura estática) |
| `console.log` do token | 2 |
Depois de reverter: 89/89.

### Achados durante o desenvolvimento
- O lint do React (hooks 7) recusou um `useRef` lido durante a renderização na busca; refatorado para o padrão de efeito com cancelamento.
- A varredura estática inicial acusava comentários que apenas citavam `localStorage`/`console`; passou a ignorar comentários.
- O teste de contrato encontrou que `UserProfile` usa `allOf` no OpenAPI; o teste agora resolve `$ref`/`allOf`.

## Não executado (a validar na máquina da equipe)
- **Navegador real / E2E** e o fluxo contra o Gateway e o backend reais: não há navegador nem Docker no ambiente. O CORS foi conferido só pela leitura de `gateway/mw_cors.go` (preflight aceita `PATCH`, `Authorization` e `Content-Type`).
- Leitor de tela, contraste medido por ferramenta, desempenho.

---

# Defeito achado no navegador: relatório com "Ocorreu um erro inesperado" (2026-11-11)
Sintoma: `GET /reports/events/{id}/summary` e `/activities` respondiam `200`, mas a tela de relatório mostrava erro genérico.
**Causa (minha):** o schema do frontend (`ReportEventSchema`) exigia `organizer_id` no evento, mas o Fastify serializa pelo **schema de resposta** de `reports/src/server.ts`, que não lista esse campo, então ele nunca chega ao cliente; a validação falhava (`INVALID_RESPONSE`, que a tela mostra como erro inesperado).
**Por que os testes não pegaram:** as fixtures traziam `organizer_id` e o teste de contrato conferia os campos contra as consultas SQL (`queries.ts`), não contra o schema de resposta.
**Correção:** `organizer_id` removido do schema e da fixture; novo teste de contrato compara cada campo exigido com o schema de resposta de `server.ts` (reintroduzir o campo faz o teste falhar). Certificados foi conferido da mesma forma contra `certificates/app/schemas/certificate.py`: sem divergência.
**Lição:** em contratos de serviços Fastify, a fonte de verdade é o schema de resposta, não a consulta.

---

# Relatório de testes — administração e pedido de organizador (DT-11)

## Execução do autor (sandbox Linux, Node 22)
| Verificação | Resultado |
|---|---|
| `prettier`, `eslint .`, `tsc --noEmit` (frontend) | **OK**, 0 problemas |
| `vitest run` (frontend) | **296/296** em 27 arquivos (eram 274 em 26) |
| `npm run build` (frontend) | **OK** |
| YAML `docs/api/users.openapi.yaml` × `GatewayExtensionTest` | rotas e limites conferidos por script: coerentes |
| Migrações `V1`+`V2` num PostgreSQL 16 local (sem Docker) | **OK**: `V2` aplica sobre dados existentes, organizador antigo vira `APPROVED`, `ADMIN` aceito, `SUPERUSER` e `organizer_request` inválido recusados pelas constraints |
| `javac` (só sintaxe) nos arquivos Java alterados | **sem erros de sintaxe**; erros de símbolo/pacote esperados (sem dependências) |

### Mutação manual no frontend (uma falha por vez)
| Falha introduzida | Resultado |
|---|---|
| cadastro ignora a escolha de organizador | 1 teste quebrou |
| rota de admin liberada ao organizador | 10 testes quebraram |
| decisão sempre envia `approved: true` | 1 teste quebrou |
| "Retirar papel" sem confirmação | 1 teste quebrou |
| sem aviso de novo login no perfil | 1 teste quebrou |
| menu de administração para organizador | 11 testes quebraram |
| tipo de conta aceita qualquer texto (ex.: `ADMIN`) | 1 teste quebrou |
| "Negar" também para quem nunca pediu | **sobreviveu** na 1ª rodada; adicionado teste e a mutação passou a ser detectada (1 teste) |

### Execução da equipe (2026-11-11, depois do patch `admin-organizer-fix1`)
`./mvnw verify` em `user/`: **BUILD SUCCESS**. Unitários **53/53** (inclui `UserServiceTest` 21, `RegisterRequestValidationTest` 7, `GatewayExtensionTest`) e integração **47/47** com Testcontainers (inclui `AdminFlowIT` 7, `AdminBootstrapIT` 1, `MigrationIT` 6, `AuthFlowIT` 14, `InfraEndpointsIT` 4). Antes disso, a 1ª rodada não compilou por um teste que ainda usava o construtor antigo de `RegisterRequest` (corrigido no `fix1`).

### NÃO EXECUTADO (importante)
- O código Java foi escrito sem compilar no ambiente do autor (sem Maven Central nem Docker); a validação real é a execução acima, feita pela equipe.
- Fluxo no navegador contra o stack real (cadastro como organizador → login do administrador → aprovar → novo login → criar evento), (a migração em si foi validada num PostgreSQL local, mas não pelo Flyway/Hibernate `validate`).
- Aplicar `register-gateway-routes.sh` num Gateway já populado (P33).

## Execução da equipe em 2026-11-11 (anterior a este ADR)
Relatório enviado pela equipe, com o stack completo (18 contêineres) e `git status` limpo: nenhum teste automatizado falhou — user 41 unitários + 38 `*IT`, events 74 + 22, payments 67, reports 63 + 8, subscription 182 (com Postgres), certificates 209, frontend 274, Go (gateway, notifications, service-discoverer) sem falhas, 1 teste do Gateway não executado (precisa de Kafka real). O fluxo cadastro → evento → inscrição → pagamento → confirmação → notificação em tempo real → check-in → relatório → certificado em PDF funcionou pela API. Achados: E1 (limite de login/cadastro ausente; **corrigido aqui**, ver P33), E2/E3/C3/C4 (P34–P37, do time) e C1/C2 (documentação e `engines`, **corrigidos aqui**). Não testados: o fluxo do navegador (passo 4) e `accept-offer` da lista de espera.

---

# Relatório de testes — frontend, fase C (Relatórios e Certificados)

## Execução (sandbox Linux, Node 22), sobre o `main` em `9b9da6a`
| Verificação | Resultado |
|---|---|
| `prettier`, `eslint .`, `tsc --noEmit` | **OK**, 0 problemas |
| `vitest run` | **274/274** em 26 arquivos (eram 235 em 23) |
| `npm run build` | **OK** |

### Mutação manual (uma falha por vez)
| Falha introduzida | Resultado |
|---|---|
| download aceita qualquer `Content-Type` | 3 testes quebraram |
| download sem token | 1 teste quebrou |
| taxa nula deixa de virar "—" | 3 testes quebraram |
| endereço temporário do PDF não é liberado | 1 teste quebrou |
| 404 do relatório não vira "não encontrado" | 1 teste quebrou |
| link de relatório também em rascunho | 1 teste quebrou |

### Não executado
- **Navegador real e ponta a ponta:** o download do PDF só foi testado com `fetch` falso, `URL.createObjectURL` simulado e clique espiado; não se testou o diálogo de salvar real, nem contra Certificados/Relatórios/Gateway reais.
- Os números de Relatórios e a emissão de certificados dependem de Kafka (eventualmente consistente); só foram exercitados com respostas simuladas.

---

# Relatório de testes — frontend, fase B (Pagamentos e Notificações)

## Execução (sandbox Linux, Node 22), sobre o `main` em `9b9da6a` (sem commits novos de outros times)
| Verificação | Resultado |
|---|---|
| `prettier`, `eslint .`, `tsc --noEmit` | **OK**, 0 problemas |
| `vitest run` | **235/235** em 23 arquivos (eram 202 em 20) |
| `npm run build` | **OK** |

### O que os testes pegaram durante o desenvolvimento
- **Bug real no contador:** o mesmo push entregue duas vezes contava 2. Corrigido deduplicando por id.
- **Correção de premissa:** eu tinha concluído que Notificações não tem tempo real porque o serviço não expõe WebSocket. O WebSocket está no **Gateway** (`/ws`); a primeira implementação (consulta periódica) foi estendida para usá-lo, mantendo a consulta como reserva. A leitura do código (`gateway/ws.go`, `push.go`, `hub.go`) agora é conferida por teste.
- O teste de segurança já existente barrou texto com "https://" na fase A2 (ver relatório abaixo); nada foi afrouxado.

### Mutação manual (uma falha por vez)
| Falha introduzida | Resultado |
|---|---|
| `payment_id` do payload usado sem validar UUID | 1 teste quebrou |
| reconectar mesmo após o fechamento `4000` | 1 teste quebrou |
| push duplicado contado duas vezes | 1 teste quebrou |
| consulta do pagamento não para no estado final | 1 teste quebrou |
| "marcar todas" enviando também as já lidas | 1 teste quebrou |

### Não executado
- **Navegador real e ponta a ponta:** o WebSocket só foi exercitado com uma conexão **falsa**; não foi testado contra o Gateway real (handshake, CORS/origem, TLS, queda e reconexão reais). Idem pagar de verdade: a aprovação depende de Kafka (Pagamentos → Inscrições) e só foi simulada.
- Reconexão com os tempos longos (4 s em diante) não é exercitada; só o primeiro intervalo.

---

# Relatório de testes — frontend, fase A2 (área do organizador)

## Execução (sandbox Linux, Node 22), sobre o `main` em `9b9da6a` (sem commits novos de outros times desde a A1)
| Verificação | Resultado |
|---|---|
| `prettier`, `eslint .`, `tsc --noEmit` | **OK**, 0 problemas |
| `vitest run` | **202/202** em 20 arquivos (eram 156 em 18) |
| `npm run build` | **OK** |

Um teste existente de segurança (`security.test.ts`) barrou uma dica de formulário que continha o texto "https://"; a mensagem foi reescrita, e a regra **não** foi afrouxada.

### Mutação manual (falha introduzida de propósito, uma por vez)
| Falha introduzida | Resultado |
|---|---|
| enviar `capacity` na edição da atividade | 1 teste quebrou |
| check-in sem exigir inscrição `CONFIRMED` | 1 teste quebrou |
| `getEvent` do organizador sem token | 1 teste quebrou |
| botão "Remover" também fora do rascunho | 1 teste quebrou |

### Não executado
- Navegador real e **ponta a ponta com os serviços de pé** (sem Docker no ambiente): criar, publicar e fazer check-in pela interface só foi exercitado com respostas simuladas, escritas a partir do código dos serviços. O teste de contrato garante que as rotas existem, não que o comportamento coincide.
- As rotas novas dependem de o Gateway tê-las como públicas com `requireAuth` (declarado no `x-gateway`); com banco do Gateway antigo vale o P24.

---

# Relatório de testes — frontend, fase A1 (Eventos e Inscrições)

## Execução (2026-11-05, sandbox Linux, Node 22), sobre o `main` em `9b9da6a`
| Verificação | Resultado |
|---|---|
| `prettier --check`, `eslint .`, `tsc --noEmit` | **OK**, 0 problemas |
| `vitest run` | **156/156** em 18 arquivos (eram 89 em 10 antes da fase A1) |
| `npm run build` | **OK** |

### O teste de contrato pegou uma mudança real de Eventos
A primeira versão desta fase foi escrita contra o contrato de Eventos de `ce82a99` e passava 153/153. Ao rebasear sobre o `main` mais novo, **1 teste falhou**: `contract.sources.test.ts` leu `events/src/http/routes.ts` e viu que as rotas passaram a ficar sob `${API}` (`/api/v1`). Investigando, Eventos também renomeou `id`→`event_id`/`activity_id` e `price_cents`→`amount_minor` (+`currency`), acrescentou `registration_open`, `lifecycle` e `ended_at`, e **removeu `available`** (Inscrições passou a ser o único contador de vagas). O cliente teria falhado contra o serviço real. Foi reescrito (schemas, caminho, vagas lidas de Inscrições) e o patch anterior foi substituído.

### Mutação manual: o código foi quebrado de propósito, uma falha por vez
| Falha introduzida | Testes que quebraram |
|---|---|
| prefixo `/api/v1` de Eventos esquecido | 30 |
| `registration_open` ignorado | 1 |
| `ACTIVITY_FULL` não revela a lotação | 1 |
| vagas livres de Inscrições ignoradas na tela | 1 |
| rastreio lê só o nome antigo `X-Request-Id` | 1 |
| disponibilidade chamada sem token | 2 |

Rodada anterior da mesma fase (contrato antigo), também detectadas: catálogo enviando token (10), mensagens em inglês expostas (2), inscrição normal virando lista de espera (1), cancelar sem confirmação (2), banner `http` exibido (1), rota de inscrição errada (7), atividade encerrada aceitando inscrição (1). Uma delas, **a normalização da data do Python, sobreviveu** na primeira tentativa porque o V8 aceita datas com espaço; a lógica virou a função pura `normalizeApiDate`, testada diretamente, e passou a ser detectada.

Observação de método: uma das mutações não chegou a ser aplicada (o shell não interpretou `$'…'`); o resultado "passou" foi descartado e a mutação foi repetida corretamente.

### Testes existentes alterados
O destino pós-login passou de `/perfil` para `/inicio`, e a raiz leva o visitante ao catálogo em vez do login.

## Não executado
- Navegador real, CORS contra o Gateway real e **a inscrição de ponta a ponta**: sem Docker no ambiente. A P21 está resolvida no código dos serviços, mas só foi exercitada com respostas simuladas.
