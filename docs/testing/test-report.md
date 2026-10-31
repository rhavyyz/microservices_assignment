# Relatório de testes — backend de Usuários

**Data:** 2026-10-31 · **Ambiente:** sandbox Linux, OpenJDK 21.0.10, PostgreSQL 16 (apt), Node/npm. **Sem Docker e sem acesso ao Maven Central** (`repo.maven.apache.org` bloqueado pelo proxy; npm, GitHub e apt funcionam).

## Conclusão
**O backend NÃO foi compilado e NENHUM teste Maven (`*Test` ou `*IT`) foi executado.** Spring Boot, Spring Security, springdoc, Testcontainers e Nimbus não puderam ser baixados. O que consta como aprovado abaixo é só o que foi de fato executado, e é parcial.

## Executado e aprovado
| # | Verificação | Comando | Resultado |
|---|---|---|---|
| 1 | Migração V1 aplicada no PostgreSQL 16 real | `psql -f V1__create_users.sql` | **OK** |
| 2 | 11 cenários de constraint no PostgreSQL 16: insert válido; e-mail duplicado (`uk_users_email`); e-mail em maiúsculas e com espaço (`ck_users_email_normalized`); status inválido; nome em branco; papel válido; papel inválido; papel repetido (`pk_user_roles`); FK órfã (`fk_user_roles_user`); delete em cascata | `src/test/sql/constraints.sql` | **11/11 conforme esperado** |
| 3 | `PemKeys` compilado com `javac` e executado com chaves do `openssl`: 2048 válida; 1024; PKCS#1; lixo; inexistente | harness em `/tmp` (não versionado) | **5/5 conforme esperado**, sem vazar conteúdo |
| 4 | OpenAPI estático válido | `@apidevtools/swagger-parser validate` | **válido** (3.0, 5 paths) |
| 5 | YAML dos composes e do `application.yml` | `python3 yaml.safe_load` | **OK** |
| 6 | Sintaxe dos scripts | `sh -n user/scripts/*.sh` | **OK** |
| 7 | Varredura do `javac` sobre todos os 45 fontes | `javac -proc:none` | **0 erros de sintaxe**; restam apenas erros por dependências ausentes (esperado) |

## Não executado
- `./mvnw verify` (compilação, `*Test`, `*IT`): **não executado**.
- Subida da aplicação, `ddl-auto=validate`, springdoc com Boot 4.1: **não verificado**.
- Docker build/compose, `register-gateway-routes.sh`, integração real com Gateway/discoverer: **não executados**.
- Nimbus/JWKS/`NimbusJwtDecoder`: **não executados** (só revisão de código).

## Riscos conhecidos de ajuste na primeira compilação
APIs que mudaram no Boot 4 / Testcontainers 2 e que não pude conferir: nomes de starters, `org.testcontainers.postgresql.PostgreSQLContainer`, chave `spring.jackson.deserialization.fail-on-unknown-properties`, compatibilidade springdoc 3.0.3 × Boot 4.1. Os testes foram escritos para falhar de forma explícita se alguma dessas premissas estiver errada.

## Como reproduzir
```
user/scripts/gen-dev-keys.sh
(cd service-discoverer/Libs/java && mvn -q install -DskipTests)   # lib de descoberta no repositório Maven local
cd user && ./mvnw verify                                          # exige Docker
```
Registrar aqui o resultado real após a primeira execução.
