# Frontend (`frontend/`)

SPA em React + TypeScript (Vite). Fala **somente com o API Gateway**, pela URL em `VITE_API_BASE_URL`; nunca com um serviço direto. Hoje consome só o serviço de Usuários (`/user/api/v1/...`); os demais entram quando seus contratos existirem.

## Telas e rotas
| Rota | Acesso | Conteúdo |
|---|---|---|
| `/` | todos | redireciona para `/perfil` (com sessão) ou `/entrar` |
| `/cadastro` | visitante | cadastro (nome, e-mail, senha, confirmação); sucesso leva ao login com aviso |
| `/entrar` | visitante | login; volta ao destino original depois de entrar |
| `/perfil` | autenticado | dados da conta e edição do nome |
| `/usuarios` | autenticado com papel `ORGANIZER` (UX) | busca por id, e-mail e nome, paginada |
| `*` | todos | página 404 |

Quem já tem sessão não vê `/entrar` nem `/cadastro`. Quem não tem o papel vê "Acesso negado" em `/usuarios`; mesmo contornando a interface, o servidor responde `403`.

## Estrutura
`src/config.ts` (URL e caminhos) · `src/api/` (cliente HTTP, erros, schemas Zod, `usersApi`) · `src/services/` (composição e contexto) · `src/auth/` (sessão em memória) · `src/components/` (layout, guardas, campos, alertas) · `src/pages/` · `src/schemas/forms.ts` (validação de formulários) · `src/test/` (apoio aos testes).

## Tratamento de erros
O cliente converte qualquer falha num `ApiError(status, code, message, traceId, fieldErrors)`:
| Origem | Resultado na interface |
|---|---|
| `problem+json` com `errors[]` (400) | mensagem no campo correspondente |
| `409 EMAIL_ALREADY_REGISTERED` | erro no campo e-mail |
| `401 INVALID_CREDENTIALS` (login) | mensagem no formulário, senha limpa, sem redirecionar |
| `401` em chamada autenticada | encerra a sessão e volta ao login com "Sua sessão expirou" (sem laço) |
| `403` | mensagem de acesso recusado; a sessão continua |
| `429`, `503`, `404` em texto puro do Gateway | mensagens próprias, sem exibir o corpo recebido |
| 5xx / `INTERNAL_ERROR` | texto genérico + "Código de suporte" (`traceId`); nenhum detalhe técnico |
| rede fora / tempo esgotado (15 s) | mensagem de conexão e botão "Tentar novamente" |
| resposta fora do contrato | `INVALID_RESPONSE`, tratada como erro inesperado |

O `X-Request-Id` pode chegar duplicado (`id, id`; P15): o primeiro valor é usado, e a mensagem prefere o `traceId` do corpo.

## Acessibilidade e responsividade
`lang="pt-BR"`, link "Ir para o conteúdo", rótulos associados, erros com `role="alert"` ligados por `aria-describedby`, estados de carregamento com `role="status"`, foco visível, tabela com `caption` e `scope`, rolagem horizontal na tabela em telas estreitas, `prefers-reduced-motion`.

## Executar
Veja o README raiz. Resumo: `cd frontend && cp .env.example .env && npm ci && npm run dev` (http://localhost:5173), com o Gateway em `VITE_API_BASE_URL`.
