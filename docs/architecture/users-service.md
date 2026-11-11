# Serviço de Usuários

## Responsabilidade e fronteiras
Cadastro, autenticação por credenciais, emissão de Access Token (JWT RS256), consulta e atualização do **próprio** perfil, papéis, auditoria e health check. **Não** trata eventos, inscrições, pagamentos, check-in, certificados, notificações ou relatórios, e não guarda dados desses domínios.

## Dados (Database per Service)
PostgreSQL privado (`user-db`), esquema por Flyway (`V1__create_users.sql`).

| Tabela | Colunas | Regras no banco |
|---|---|---|
| `users` | `id` UUID, `name`, `email`, `password_hash`, `status`, `created_at`, `updated_at` | `UNIQUE(email)`; `CHECK email = lower(btrim(email))`; status `ACTIVE`/`INACTIVE`; nome não vazio |
| `user_roles` | `user_id`, `role` | PK composta; FK com `ON DELETE CASCADE`; role `PARTICIPANT`/`ORGANIZER`/`ADMIN`; `users` tem `organizer_request` (`NONE`/`PENDING`/`APPROVED`/`DENIED`) e `organizer_request_updated_at` (V2, ADR-009) |

Outros serviços não acessam essas tabelas: usam o JWT e a API.

## Regras de negócio
1. Cadastro público cria **somente** `PARTICIPANT`. Campos `roles`, `isAdmin` etc. são rejeitados (400) e, mesmo que fossem aceitos, nunca são lidos (a assinatura de `register` não recebe papéis).
2. E-mail: `strip()` + minúsculas (`Locale.ROOT`), ASCII (IDN fora do escopo). Unicidade garantida pelo banco; corrida de cadastros vira `409`.
3. Senha: 10–72 caracteres e **no máximo 72 bytes UTF-8** (limite do BCrypt; recusada em vez de truncada). Hash BCrypt custo 12.
4. Login: falhas (e-mail inexistente, senha errada, conta inativa) retornam a mesma resposta; um hash descartável equaliza o tempo quando o e-mail não existe.
5. `/users/me` usa o `sub` do token; não há `{id}` em nenhuma rota. Só `name` é editável.
6. Busca de usuários (`GET /api/v1/users`): somente `ORGANIZER` (conferido no token **e** no banco), ao menos um filtro entre `id` (exato), `email` e `name` (contém, sem diferenciar maiúsculas, `%`/`_` literais), AND entre filtros, paginação obrigatória (máx. 50), ordenação por nome, sem hash de senha. É a única rota que lê dados de terceiros (ver P18).
7. `ORGANIZER` só é concedido por um `ADMIN` (ADR-009): o cadastro com `requestedRole=ORGANIZER` só abre um pedido `PENDING`. `ADMIN` só nasce do bootstrap por ambiente (`USERS_ADMIN_BOOTSTRAP_*`, desativado por padrão); o seed de desenvolvimento do ADR-002 continua existindo. Rotas `/api/v1/admin/users` (lista) e `/api/v1/admin/users/{id}/organizer` (decisão): papel `ADMIN` no token **e** no banco. `ORGANIZER` não dá acesso a todos os eventos: o serviço de Eventos valida a responsabilidade (RN07).

## Segurança
JWT RS256 com claims `sub`, `roles`, `iss`, `iat`, `exp`, `jti`; validade `USERS_JWT_TTL_SECONDS` (padrão 1800). Chave privada em arquivo montado (mesma em todas as réplicas), chave pública em `/.well-known/jwks.json`. Validação recusa `alg=none`, chave desconhecida, emissor diferente e token expirado. API stateless (sem cookies), logo CSRF desativado. Respostas e logs nunca trazem hash, senha, token ou stack trace.

## Observabilidade
- `GET /healthcheck` (Actuator, só `UP`/`DOWN`, inclui o banco). Contrato do discoverer.
- Auditoria: logger `AUDIT` com `operation`, `result`, `userId`, `emailFingerprint`; JSON em Docker (`LOGGING_STRUCTURED_FORMAT_CONSOLE=logstash`).
- `X-Trace-Id` aceito se `^[A-Za-z0-9._-]{8,64}$`, senão gerado; vai ao MDC, aos logs e ao `traceId` dos erros.

## Estrutura do código (`user/src/main/java/com/eventhub/users`)
`web` (controllers, DTOs, erros, filtro) · `user` (entidade, repositório, `UserService`) · `security` (cadeia, JWT, chaves) · `audit` · `discovery` · `dev` (seed) · `config`.

## Integração
Ver `docs/integration/contracts-with-team.md`. Diagramas em `docs/architecture/diagrams/`.
