# ADR-004 — Versões, dependências e estratégia de testes do backend

- **Estado:** Aceito
- **Data:** 2026-10-31

## Contexto
O repositório não define pilha para Usuários. O prompt exige versões estáveis e suportadas. Consulta em 2026-10-31: Spring Boot **4.1** (GA em 2026-06-10, patch 4.1.1 em 2026-08-20) e 4.0 (suporte OSS até 2026-12-31) estão suportados; a 3.5 saiu de suporte em 2026-06-30.

## Decisão
- **Java 21 (LTS)**, **Spring Boot 4.1.1** (Spring Framework 7, Security 7, Jackson 3, Hibernate 7), Maven com wrapper oficial 3.3.4 (Maven 3.9.11).
- Starters do Boot 4 (nomes novos): `webmvc`, `security`, `security-oauth2-resource-server`, `data-jpa`, `validation`, `actuator`, `flyway` (+ `flyway-database-postgresql`).
- **springdoc-openapi 3.0.3** (`webmvc-api`, sem Swagger UI). *Risco:* a linha 3.x declara suporte ao Boot 4.0; a compatibilidade com 4.1 não foi confirmada em fonte oficial. Se falhar ao iniciar, o Gateway não aprende as rotas: é o primeiro ponto a verificar.
- **Testcontainers 2.x** (versão do BOM do Boot), isolado em `PostgresIT`.
- **JWT:** uma só biblioteca (Nimbus, via Spring Security) para emitir e validar.
- **BCrypt** com custo 12 (configurável); Argon2id descartado por exigir dependência extra (BouncyCastle).
- Erros em `application/problem+json` montado à mão em `Problems`: o mesmo formato serve ao MVC e à cadeia de segurança, sem depender da configuração do Jackson 3.
- Testes: `*Test` (surefire, sem Docker) e `*IT` (failsafe, PostgreSQL real via Docker). Os ITs usam o cliente HTTP do JDK contra o Tomcat real em vez de `MockMvc`, para exercitar filtros e segurança de ponta a ponta sem depender de pacotes de teste específicos do Boot 4.

## Alternativas
- Boot 3.5: sem suporte desde junho de 2026. Boot 4.0: suporte acaba em 2026-12-31.
- H2 nos ITs: não valida constraints do PostgreSQL real.

## Consequências
O código foi inicialmente escrito sem acesso ao Maven Central. A primeira execução real (ver `docs/testing/test-report.md`) confirmou as premissas de API do Boot 4.1.1, springdoc 3.0.3 × Boot 4.1, Testcontainers 2.0.5 (`org.testcontainers.postgresql.PostgreSQLContainer`) e `spring.jackson.deserialization.fail-on-unknown-properties`: tudo compilou e funcionou. Os únicos ajustes foram bugs de teste.
