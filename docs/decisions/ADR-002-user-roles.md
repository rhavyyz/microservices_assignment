# ADR-002 — Papéis de usuário

- **Estado:** Proposto (aguarda P7)
- **Data:** 2026-10-30

## Contexto
RF01 exige diferenciar participantes e organizadores. RN07 diz que ser `ORGANIZER` **não** dá acesso a todos os eventos: a responsabilidade pelo evento é validada pelo serviço de Eventos.

## Decisão
- Papéis: `PARTICIPANT` e `ORGANIZER`, em tabela `user_roles` (um usuário pode ter mais de um).
- O cadastro público cria **somente** `PARTICIPANT`. Campos como `roles`, `isAdmin` ou `isOrganizer` são **rejeitados** (`400 MALFORMED_REQUEST`), não ignorados em silêncio.
- `PATCH /users/me` altera apenas `name`.
- Não há endpoint de promoção. Em desenvolvimento local, um seed de organizador de demonstração fica **desativado por padrão** e só é ativado por `USERS_DEV_SEED_ENABLED=true` com credenciais vindas do ambiente (nunca do repositório).
- O fluxo de criação de organizadores em produção é decisão da equipe (P7).
- O papel no JWT é apenas informativo para os consumidores; autorização por recurso é do serviço dono do recurso.

## Alternativas
- **Auto-declaração no cadastro:** inseguro.
- **Endpoint administrativo de promoção:** sem requisito aprovado; evita-se superfície de ataque.

## Consequências
Sem fluxo de produção para `ORGANIZER`, a área de organizador só pode ser demonstrada com o seed de desenvolvimento.
