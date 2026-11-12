# Frontend (`frontend/`)

SPA em React + TypeScript (Vite). Fala **somente com o API Gateway**, pela URL em `VITE_API_BASE_URL`; nunca com um serviço direto. Consome Usuários, Eventos, Inscrições, Pagamentos, Notificações, Relatórios e Certificados, sempre pelo Gateway (`/{serviço}/api/v1/...`).

## Telas e rotas
| Rota | Acesso | Conteúdo | Serviço |
|---|---|---|---|
| `/` | todos | visitante vai ao catálogo; autenticado vai a `/inicio` | — |
| `/eventos` | público | catálogo com busca, período e paginação (na URL) | Eventos |
| `/eventos/:eventId` | público | evento, atividades e preço; vagas livres só para autenticado; inscrição por atividade (exige login) | Eventos, Inscrições |
| `/cadastro`, `/entrar` | visitante | cadastro (tipo de conta: participante ou organizador, que só abre um pedido) e login | Usuários |
| `/inicio` | autenticado | atalhos da jornada | — |
| `/inscricoes` | autenticado | minhas inscrições: situação, prazo, aceitar oferta, cancelar | Inscrições, Eventos |
| `/pagamentos/:paymentId` | autenticado | situação do pagamento (atualiza sozinho enquanto pendente) e provedor simulado | Pagamentos |
| `/notificacoes` | autenticado | lista, filtro "Não lidas", marcar como lida, tempo real | Notificações, Gateway (`/ws`) |
| `/certificados` | autenticado | meus certificados e download do PDF (com token, via `fetch`) | Certificados, Eventos |
| `/organizador/eventos/:eventId/relatorio` | organizador | indicadores do evento e tabela por atividade (dinheiro por moeda, taxas) | Relatórios |
| `/admin/usuarios` | administrador | todos os usuários, quem pediu para ser organizador (filtros e busca), aprovar, negar ou retirar o papel | Usuários |
| `/organizador` | organizador | meus eventos (inclui rascunhos) com paginação | Eventos |
| `/organizador/novo` | organizador | criar evento (nasce como rascunho) | Eventos |
| `/organizador/eventos/:eventId` | organizador | editar, publicar, cancelar; adicionar, editar, remover e encerrar atividades | Eventos |
| `/organizador/atividades/:activityId/participantes` | organizador | participantes e check-in | Inscrições, Usuários, Eventos |
| `/perfil` | autenticado | dados da conta e edição do nome | Usuários |
| `/usuarios` | `ORGANIZER` (UX) | busca de usuários | Usuários |
| `*` | todos | 404 |  |

Quem já tem sessão não vê `/entrar` nem `/cadastro`. Quem não tem o papel vê "Acesso negado" em `/usuarios`; mesmo contornando a interface, o servidor responde `403`. Próximas fases: DT-08.

## Estrutura
`src/config.ts` (URL e caminhos) · `src/api/` (cliente HTTP, erros, schemas Zod e funções tipadas: `usersApi`, `eventsApi`, `subscriptionApi`) · `src/services/` (composição e contexto) · `src/auth/` (sessão em memória) · `src/components/` (layout, guardas, campos, alertas) · `src/pages/` · `src/schemas/forms.ts` (validação de formulários) · `src/test/` (apoio aos testes).

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
| códigos de Eventos/Inscrições (`ACTIVITY_FULL`, `EVENT_CANCELLED`, `DEPENDENCY_UNAVAILABLE`…) | texto em português por código; o texto do servidor não é exibido |
| 5xx / `INTERNAL_ERROR` | texto genérico + "Código de suporte" (`traceId`); nenhum detalhe técnico |
| rede fora / tempo esgotado (15 s) | mensagem de conexão e botão "Tentar novamente" |
| resposta fora do contrato | `INVALID_RESPONSE`, tratada como erro inesperado |

O `X-Trace-Id` pode chegar duplicado (`id, id`; P15): o primeiro valor é usado (o nome antigo `X-Request-Id` ainda é aceito), e a mensagem prefere o `traceId` do corpo.

## Acessibilidade e responsividade
`lang="pt-BR"`, link "Ir para o conteúdo", rótulos associados, erros com `role="alert"` ligados por `aria-describedby`, estados de carregamento com `role="status"`, foco visível, tabela com `caption` e `scope`, rolagem horizontal na tabela em telas estreitas, `prefers-reduced-motion`.

## Executar
Veja o README raiz. Resumo: `cd frontend && cp .env.example .env && npm ci && npm run dev` (http://localhost:5173), com o Gateway em `VITE_API_BASE_URL`.
