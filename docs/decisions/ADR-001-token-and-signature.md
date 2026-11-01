# ADR-001 — Access Token e assinatura

- **Estado:** Proposto (aguarda confirmação da equipe — P3, P5, P6)
- **Data:** 2026-10-30

## Contexto
O padrão acordado é *Access Token*. Todos os serviços precisam validar assinatura, emissor e expiração sem consultar o banco de Usuários. O `docker-compose` raiz permite várias réplicas por serviço (`deploy.replicas`).

## Decisão
- JWT assinado com **RS256** (Nimbus JOSE + JWT via Spring Security; nenhuma segunda biblioteca JWT).
- Claims: `sub` (UUID), `roles`, `iss`, `iat`, `exp`, `jti`. Sem senha nem dados de perfil.
- Validade em `USERS_JWT_TTL_SECONDS` (padrão 1800). Emissor em `USERS_JWT_ISSUER` (padrão `eventhub-users`).
- **A chave privada é injetada por configuração** (`USERS_JWT_PRIVATE_KEY_FILE`, PEM montado como secret) e **nunca gerada por instância**: com réplicas, uma chave por instância faria tokens emitidos por uma réplica serem rejeitados por outra. `kid` configurável (`USERS_JWT_KEY_ID`).
- Chave pública exposta em `GET /.well-known/jwks.json`; consumidores localizam o serviço via `GET /consult?kind=user` do discoverer. Alternativa aceita: distribuir a chave pública por configuração.
- Sem refresh token e sem servidor OAuth completo no escopo inicial.
- Chaves de desenvolvimento são geradas por script local, em diretório ignorado pelo git.

## Alternativas
- **HS256 (segredo compartilhado):** descartado; todo consumidor poderia forjar tokens.
- **Token opaco com introspecção:** descartado; acopla todos os serviços a Usuários em cada requisição (RQ01/RQ03).
- **Chave gerada na inicialização:** descartada pelo problema das réplicas.

## Consequências
- Rotação de chave exige publicar duas chaves no JWKS durante a transição (fora do escopo inicial).
- Revogação antes do `exp` não é suportada; mitigada pela validade curta.
