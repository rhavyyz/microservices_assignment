# ADR-006 — Frontend: sessão em memória e pilha

- **Estado:** Aceito
- **Data:** 2026-11-04

## Contexto
O serviço de Usuários emite um Access Token JWT (30 min) e o Gateway o valida. Não existe refresh token nem cookie `HttpOnly`. Guardar o token em `localStorage`/`sessionStorage` o deixaria legível por qualquer script injetado (XSS), e o prompt do projeto proíbe persistir token no navegador.

## Decisão
- **O Access Token vive somente em memória** (variável fechada em `createServices`), nunca em `localStorage`, `sessionStorage`, `IndexedDB` ou cookie. Consequência aceita: **recarregar a página exige novo login**; não há "lembrar de mim".
- A sessão termina em três casos: logout, expiração (temporizador pelo `expiresIn`) e **qualquer 401 numa chamada autenticada**. O 401 do próprio login não encerra nada (é só "credenciais inválidas"), o que evita laços de redirecionamento.
- O cliente HTTP central é o único ponto que monta `Authorization`, usa `credentials: 'omit'` e `cache: 'no-store'`.
- Rotas protegidas no cliente (`RequireAuth`, `RequireRole`) são só experiência de navegação: **o backend autoriza** (401/403), e a interface exibe o que ele decidir.
- Toda resposta é validada com Zod (`INVALID_RESPONSE` se fugir do contrato) e um teste compara esses schemas e as rotas chamadas com `docs/api/users.openapi.yaml`.
- A URL do Gateway vem de `VITE_API_BASE_URL` (valor público no bundle, sem segredos); os caminhos das APIs ficam em `src/config.ts`.
- ESLint proíbe `console.*`, `localStorage` e `sessionStorage`; um teste varre o código (sem comentários) atrás de IPs, `localhost`, URLs absolutas e `Authorization` fora do cliente.

## Pilha e versões (verificadas no npm em 2026-11-04, instaladas e executadas)
React 19.3.1, React Router 8.5.1, Vite 8.3.5 (+ plugin-react 6.2.1), **TypeScript 6.0.3**, Vitest 5.1.0 + Testing Library (react 16.3.3, user-event 14.6.8) + jsdom 30.1.3, React Hook Form 7.91.0 + `@hookform/resolvers` 7.0.2 + Zod 4.6.7, ESLint 10.14.0 + typescript-eslint 8.72.1, Prettier 3.9.10. Node: `^20.19 || >=22.12`.

O TypeScript 7.0.2 já existe, mas o `typescript-eslint` 8.72.1 declara `typescript >=4.8.4 <6.1.0`; ficamos no 6.0.3 até o lint suportar o 7. O `@hookform/resolvers` só é necessário para ligar o Zod ao React Hook Form.

## Alternativas
- Token em `sessionStorage`: sobrevive ao recarregar, mas fica exposto a XSS; rejeitado.
- Cookie `HttpOnly` com refresh token: o correto para persistir, mas exige mudança no backend e no Gateway; fora do escopo.
- MSW nos testes: descartado; um `fetch` falso por rotas basta e evita mais uma dependência.

## Consequências
Experiência: recarregar a página desloga. Segurança: o token não sobrevive a XSS persistente nem a abas compartilhadas. Esta ADR deve ser revista se o backend passar a oferecer refresh token em cookie `HttpOnly`.
