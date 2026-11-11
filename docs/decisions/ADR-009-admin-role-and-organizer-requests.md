# ADR-009 — Papel ADMIN e pedido de organizador

- **Estado:** Aceito (substitui a parte de "como se cria um organizador" do ADR-002; resolve P7)
- **Data:** 2026-11-11

## Contexto
O ADR-002 deixava o papel `ORGANIZER` sem fluxo de produção: só o seed de desenvolvimento criava um. O teste de ponta a ponta de 2026-11-11 mostrou o problema na prática: ninguém consegue demonstrar a área do organizador sem mexer no banco ou no ambiente. A equipe pediu: o **cadastro permite escolher o papel**; quem escolhe "organizador" **não ganha o papel na hora**; uma **tela de administração lista todos os usuários, identifica quem pediu para ser organizador** e o administrador **concede ou nega**.

## Decisão
1. **Cadastro (`POST /api/v1/auth/register`)** aceita o campo opcional `requestedRole` (`PARTICIPANT`, padrão, ou `ORGANIZER`). Qualquer outro valor (inclusive `ADMIN`) é `400`. A conta nasce **sempre só com `PARTICIPANT`**; com `ORGANIZER` ela recebe `organizerRequest = PENDING`. Campos como `roles` e `isAdmin` continuam rejeitados (`400 MALFORMED_REQUEST`).
2. **Pedido de organizador** (`organizerRequest`): `NONE` (nunca pediu), `PENDING` (aguarda), `APPROVED` (um ADMIN concedeu), `DENIED` (um ADMIN negou ou retirou). Fica em colunas novas de `users` (migração `V2`); quem já era organizador antes da migração vira `APPROVED`.
3. **Papel `ADMIN`** (novo em `user_roles`). **Nenhuma rota HTTP concede ADMIN.** O primeiro administrador vem de `USERS_ADMIN_BOOTSTRAP_*` (desativado por padrão, credenciais só do ambiente, idempotente, conta com **apenas** `ADMIN`). Administrador não é organizador nem participante: ele administra.
4. **Rotas do ADMIN** (`/api/v1/admin/**`, exigem `hasRole("ADMIN")` na cadeia de segurança **e** conferem o papel no banco de novo, como a busca de usuários):
   - `GET /api/v1/admin/users?q&organizerRequest&page&size`: lista todos (sem exigir filtro), com a situação do pedido; `q` procura em nome e e-mail; máx. 50 por página; nunca devolve hash de senha.
   - `PUT /api/v1/admin/users/{id}/organizer` com `{"approved": true|false}`: concede `ORGANIZER` ou nega o pedido/retira o papel. **Idempotente.** Administradores não são alvo (`409 ADMIN_TARGET_NOT_ALLOWED`); aprovar conta inativa é recusado.
5. **O papel só vale no token depois de um novo login.** O JWT carrega `roles` e dura 30 min (ADR-001/006); não há refresh. Consequências aceitas: (a) quem foi aprovado precisa **sair e entrar de novo** (o perfil e a tela do administrador avisam); (b) quem teve o papel retirado mantém o token antigo até ele expirar em **outros serviços** que confiam nas claims. No serviço de Usuários a conferência no banco vale na hora (a busca de usuários passa a dar `403`).
6. **Auditoria:** novas operações `ADMIN_USER_LIST`, `ORGANIZER_GRANTED` e `ORGANIZER_DENIED`, só com ids (quem agiu e sobre quem), sem dados pessoais.
7. **Frontend:** o cadastro tem "Tipo de conta" (Participante/Organizador, nunca Administrador) e avisa que o pedido aguarda aprovação; `/admin/usuarios` (só ADMIN, menu "Administração") tem busca, filtros (Todos, Aguardando aprovação, Aprovados, Negados, Sem pedido), **Aprovar**, **Negar** (só pedido pendente) e **Retirar papel** (com confirmação). O perfil mostra a situação do pedido. Esconder telas é só experiência: o servidor recusa o que não é permitido.
8. **Limites do Gateway (E1 do relatório de testes):** `@GatewaySettings` ganhou `maxPerMin` e `rateLimitBy`, publicados no `x-gateway`. Login e cadastro: **10/min por IP**; `users/me` 120 e 30; busca 60; rotas de admin 60 e 30. O Gateway só semeia rotas novas (P24): num banco do Gateway **já populado**, aplicar com `user/scripts/register-gateway-routes.sh` ou `PUT /admin/endpoints`.

## Alternativas
- **Promoção por qualquer organizador:** simples, mas um organizador comprometido vira ponto de escalada.
- **Auto-declaração no cadastro:** inseguro (ADR-002).
- **Só o seed:** sem fluxo de produção.
- **ADMIN criado por rota HTTP:** criaria um caminho de escalada de privilégio; ficou só o bootstrap por ambiente.

## Consequências
- Primeiro uso: definir `USERS_ADMIN_BOOTSTRAP_ENABLED=true` com nome, e-mail e senha no `.env`, subir o serviço, entrar como administrador e aprovar quem pediu. Depois, desligar o bootstrap.
- **Validado:** `./mvnw verify` da equipe em 2026-11-11 passou (53 unitários e 47 integrações, incluindo `AdminFlowIT`, `AdminBootstrapIT` e `MigrationIT`). **Não validado:** o fluxo no navegador contra o stack completo.
- Não há tela para rebaixar um administrador nem para criar outro: é operação de banco/ambiente.
