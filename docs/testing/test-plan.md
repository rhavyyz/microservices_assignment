# Plano de testes — backend de Usuários

`./mvnw test` executa os `*Test` (sem Docker). `./mvnw verify` também executa os `*IT` (exigem Docker para o PostgreSQL via Testcontainers).

| Requisito | Caso | Ferramenta / arquivo | Esperado |
|---|---|---|---|
| RF01 cadastro | Cadastro válido cria `PARTICIPANT`, e-mail normalizado, hash BCrypt | `UserServiceTest`, `AuthFlowIT` | 201; roles `[PARTICIPANT]` |
| RF01 validação | Campos vazios, e-mail inválido, senha curta/longa | `RegisterRequestValidationTest`, `AuthFlowIT` | 400 `VALIDATION_ERROR`, sem eco da senha |
| RF01 / 6.1 e-mail único | Duplicado, caixa/espaços, corrida de 8 requisições, constraint do banco | `UserServiceTest`, `AuthFlowIT`, `MigrationIT`, `scripts/check-migration.sh` | 409; exatamente 1 conta |
| RN07 papéis | `roles`/`isAdmin` no cadastro e no PATCH | `AuthFlowIT` | 400 `MALFORMED_REQUEST`; nada criado/alterado |
| RN07 / ADR-002 | Seed desativado por padrão; ativado cria `ORGANIZER` | `NoSeedByDefaultIT`, `DevSeedIT` | conforme configuração |
| Login | Válido; senha errada; e-mail inexistente; conta inativa; senha > 72 bytes | `UserServiceTest`, `AuthFlowIT` | respostas idênticas (401 genérico) |
| Token | Claims exatas, `exp-iat`, `kid`; expirado, adulterado, `alg=none`, outra chave, outro emissor | `TokenServiceTest`, `AuthFlowIT` | 401 `UNAUTHENTICATED` |
| Perfil | GET/PATCH próprio; sem rota para terceiros; sem hash na resposta | `AuthFlowIT` | 200 / 404 |
| Busca | Só `ORGANIZER`; rebaixado perde acesso antes do token expirar; filtros id/e-mail/nome, AND, sem diferenciar maiúsculas; `%`/`_` literais; paginação e ordenação; entradas inválidas sem eco; sem hash | `UserServiceTest`, `UserSpecificationsTest`, `UserSearchIT` | 200/400/401/403 conforme |
| Chaves | PKCS#8 válida; 1024 bits, PKCS#1, lixo, ausente sem vazar conteúdo | `PemKeysTest` | erro claro |
| JWKS | Somente `n`,`e`,`kid`; sem `d`,`p`,`q`,`dp`,`dq`,`qi` | `TokenServiceTest`, `InfraEndpointsIT` | público apenas |
| RQ06 | `X-Trace-Id` seguro mantido; inseguro substituído; `traceId` do erro igual ao cabeçalho | `TraceIdFilterTest`, `AuthFlowIT` | conforme |
| RQ06 erros | Formato único; sem stack/SQL/classes | `ProblemsTest`, `AuthFlowIT` | conforme |
| RQ06 logs | Sem senha, token, `Authorization` ou e-mail em claro | `AuditLoggingTest`, `AuthFlowIT` | conforme |
| 11.1 health | `/healthcheck` UP sem detalhes; actuator/env não expostos | `InfraEndpointsIT` | 200 / não 200 |
| Gateway | `/openapi.json` lista as 4 operações | `InfraEndpointsIT` | presentes |
| Migração | Flyway V1; `ddl-auto=validate` passa | `MigrationIT` (+ app subindo) | sucesso |
| Contrato | OpenAPI estático válido | `swagger-parser` | válido |

Não coberto: carga/pico, rate limit (Gateway), `register-gateway-routes.sh` e Docker Compose (sem Docker no ambiente de desenvolvimento).
