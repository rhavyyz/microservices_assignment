# Relatório de testes — backend de Usuários

## Execução 2 — `./mvnw verify` na máquina da equipe (2026-10-31, 15:00 -03)
**Ambiente:** Ubuntu 24.04, JDK 21.0.12, Docker 29.9.0 (Server API 1.56), Testcontainers 2.0.5, `postgres:16-alpine` (PostgreSQL 16.15), Spring Boot 4.1.1, Hibernate 7.4.5, Spring Security 7.1.1, springdoc 3.0.3.

| Fase | Resultado |
|---|---|
| Compilação (30 fontes main, 15 test) | **OK** |
| `*Test` (surefire, sem Docker) | **26/26 aprovados** (após corrigir a asserção do `iss`, ver abaixo) |
| `*IT` (failsafe, PostgreSQL real) | **22/23 aprovados; 1 erro no próprio teste** (corrigido, **re-execução pendente**) |

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

## Execução 3 — busca de usuários (`GET /api/v1/users`) — **pendente**
Código e testes escritos (`UserServiceTest` +3, `UserSpecificationsTest`, `UserSearchIT` com 8 casos, `InfraEndpointsIT` e `AuthFlowIT` ajustados), mas **ainda não executados**. Registrar aqui o resultado do próximo `./mvnw verify`. Pontos de atenção na primeira execução: API de `Specification` do Spring Data JPA 4.x, `like(..., escape)` no PostgreSQL e o tratamento de `MethodArgumentTypeMismatchException`.

## Execução 1 — sandbox sem Maven Central (2026-10-31, antes da execução 2)
Verificações parciais, todas aprovadas: migração e 11 cenários de constraint no PostgreSQL 16 (`src/test/sql/constraints.sql`), `PemKeys` com chaves do `openssl` (5 cenários), OpenAPI estático válido (`swagger-parser`), YAML dos composes e scripts. Substituída pela execução 2, que cobre compilação e testes completos.

## Ainda não executado
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
