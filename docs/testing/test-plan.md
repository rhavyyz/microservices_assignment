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

---

# Plano de testes — frontend

`cd frontend && npm run test:run`. Vitest + Testing Library em jsdom; o `fetch` é substituído por um falso baseado em rotas (rota imprevista falha o teste).

| Requisito | Caso | Arquivo | Esperado |
|---|---|---|---|
| Validação | cadastro, login, perfil, busca (obrigatórios, e-mail, senha 10–72 e bytes, confirmação, nome, ao menos um filtro) | `schemas/forms.test.ts`, páginas | mensagens em pt-BR; nenhuma chamada à API |
| Cadastro | sucesso (envia só nome/e-mail/senha), 409, erros do servidor por campo, rede, 500 sem detalhes, envio duplicado | `RegisterPage.test.tsx` | conforme |
| Login | 401 sem redirecionar nem repetir, sucesso, retorno ao destino original, 429/503 em texto puro, resposta fora do contrato | `LoginPage.test.tsx` | conforme |
| Rotas | protegida sem sessão, organizador x participante, visitante com sessão, logout limpa o token, 404, redirecionamento seguro | `routing.test.tsx` | conforme |
| Perfil | carregando, dados, PATCH só com `name`, erro de campo, 401 (sem laço) na consulta e ao salvar, 403 mantém sessão, rede + tentar novamente, 503 | `ProfilePage.test.tsx` | conforme |
| Busca | filtro obrigatório, parâmetros e Bearer corretos, vazio, paginação, 403 e 400 do servidor | `UsersSearchPage.test.tsx` | conforme |
| Cliente HTTP | URL do Gateway, Bearer só quando autenticado e nunca na URL, `credentials: omit`, problem+json, texto puro do Gateway, `X-Request-Id` duplicado, rede, timeout, cancelamento, resposta inválida | `api/client.test.ts` | conforme |
| Contrato | schemas e rotas == `docs/api/users.openapi.yaml` | `api/contract.test.ts` | conforme |
| Configuração | `VITE_API_BASE_URL` ausente/inválida | `config.test.ts` | erro claro |
| Segurança | sem `localStorage`/`sessionStorage`/cookies, sem `console`, sem IP/localhost/URL fixa, `Authorization` só no cliente; senha/token fora de console e DOM | `security.test.ts` | conforme |

Não coberto: navegador real (E2E), CORS contra o Gateway real, leitor de tela, desempenho. Ver `test-report.md`.

## Administração e pedido de organizador (ADR-009)
| Requisito | Caso | Arquivo | Esperado |
|---|---|---|---|
| Cadastro | `requestedRole` só `PARTICIPANT`/`ORGANIZER`; `ADMIN` e valores soltos são `400`; `ORGANIZER` abre `PENDING` e nunca concede o papel; `roles`/`isAdmin` continuam rejeitados | `RegisterRequestValidationTest`, `UserServiceTest`, `AdminFlowIT` (Java) | conforme* |
| Admin (backend) | só `ADMIN` lista e decide (organizador/participante: `403`; sem token: `401`); filtros e paginação validados; aprovar concede, negar/retirar remove; idempotente; administrador nunca é alvo (`409`); papel retirado vale na hora na busca; novo login traz o papel | `UserServiceTest`, `AdminFlowIT` (Java) | conforme* |
| Bootstrap | só com a variável ligada; conta com apenas `ADMIN`; e-mail tomado para o cadastro público | `AdminBootstrapIT` (Java) | conforme* |
| Banco | `ADMIN` aceito, papel desconhecido e `organizer_request` inválido recusados | `MigrationIT` (Java) | conforme* |
| Gateway (E1) | `x-gateway` publica `maxPerMin`/`rateLimitBy` (login e cadastro 10/min por IP) e as rotas de admin; YAML versionado coerente | `GatewayExtensionTest`, `InfraEndpointsIT` (Java) | conforme* |
| Cadastro (tela) | começa em Participante; só Participante/Organizer (nunca Administrador); corpo com `requestedRole`; aviso de aprovação pendente | `RegisterPage.test.tsx`, `forms.test.ts` | conforme |
| Tela de admin | lista com Bearer, situação do pedido, filtros e busca, aprovar, negar (só pendente), retirar com confirmação, 409, erro + tentar de novo, vazio, paginação, acesso negado a não admin | `AdminUsersPage.test.tsx` | conforme |
| Perfil e início | pedido pendente/negado; aviso de novo login após aprovação; atalho de admin só para ADMIN | `ProfilePage.test.tsx`, `HomePage.test.tsx` | conforme |
| Contrato | schemas e rotas de admin e `requestedRole` conferidos contra o OpenAPI | `api/contract.test.ts` | conforme |

\* Testes Java **escritos mas não executados** pelo autor (sem Maven Central e sem Docker no ambiente); ver `test-report.md`.

## Fase C (Relatórios e Certificados)
| Requisito | Caso | Arquivo | Esperado |
|---|---|---|---|
| Relatório | resumo e tabela por atividade com Bearer; moeda por moeda sem somar; `UNKNOWN`; taxa nula "—"; zero como valor; paginação; "Atualizar"; 404 vira não encontrado; erro + tentar de novo; resposta fora do contrato | `ReportPage.test.tsx` | conforme |
| Certificados | lista com título do evento; sem título quando `event_id` nulo; "Baixar PDF" com Bearer e nome do arquivo; `Content-Type` errado, 404 e 503 traduzidos; estado vazio com a regra dos 75%; "Próxima" só com página cheia | `CertificatesPage.test.tsx` | conforme |
| Cliente | `requestBlob` exige o tipo, envia `Accept`, não vaza corpo de erro | `client.test.ts` | conforme |
| Formatação | `formatMoney`, `formatRate` | `format.test.ts` | conforme |
| Navegação | link de relatório só em evento não rascunho; menu "Certificados" | `OrganizerPages.test.tsx`, `HomePage.test.tsx` | conforme |
| Contrato | rotas, `x-gateway` e campos conferidos no código de Relatórios e Certificados; não há rota de criação de certificado | `api/contract.reportscerts.test.ts` | conforme |

## Fase B (Pagamentos e Notificações)
| Requisito | Caso | Arquivo | Esperado |
|---|---|---|---|
| Pagar | só `PENDING_PAYMENT` tem "Pagar"; corpo só com `registration_id`; `REGISTRATION_NOT_PAYABLE` traduzido | `PaymentPage.test.tsx` | conforme |
| Pagamento | valor/situação/prazo com Bearer; aprovar, recusar, expirar; `PAYMENT_NOT_APPLIED` recarrega o estado; simulador desligado; consulta periódica e parada no estado final; 404, id inválido, 503 em texto, resposta fora do contrato | `PaymentPage.test.tsx` | conforme |
| Lista | Nova/Lida, link por tipo, `redirect_url` e `payment_id` inválido nunca viram link, vazio, filtro, cursor, erro + tentar de novo | `NotificationsPage.test.tsx` | conforme |
| Marcar como lida | uma, todas (só as não lidas), erro parcial | `NotificationsPage.test.tsx` | conforme |
| Tempo real | conecta com token na query só depois do login; push entra no topo sem duplicar; contador; quadros inválidos ignorados; reconecta com espera; `4000` não reconecta; sair fecha | `NotificationsPage.test.tsx` | conforme |
| Contrato | rotas de Pagamentos e Notificações existem no código dos serviços e são públicas com `requireAuth`; `/ws` e os quadros existem no Gateway | `api/contract.payments.test.ts` | conforme |

## Fase A2 (área do organizador)
| Requisito | Caso | Arquivo | Esperado |
|---|---|---|---|
| Meus eventos | lista com rascunhos e Bearer, estado vazio, erro + tentar de novo, paginação pelo total | `OrganizerPages.test.tsx` | conforme |
| Novo evento | validação sem chamar a API, corpo exato do POST (datas ISO, vazios → null), erro de regra traduzido | `OrganizerPages.test.tsx` | conforme |
| Gestão | leitura com token, publicar (e `EVENT_WITHOUT_ACTIVITIES`), cancelar com confirmação, editar evento, adicionar atividade (centavos, capacidade, lista de espera), atividade fora do período, editar sem `capacity` e preço/capacidade só leitura, remover só em rascunho, encerrar só após o término, 404, id inválido | `OrganizerPages.test.tsx` | conforme |
| Participantes | nome/e-mail por busca de id, falha da busca (id curto), check-in só CONFIRMED e na janela, erro traduzido, 403, vazio | `OrganizerPages.test.tsx` | conforme |
| Formulários | conversões reais↔centavos, datetime↔ISO, limites e período | `schemas/organizer.test.ts` | conforme |
| Contrato | as 11 rotas novas existem no código de Eventos e Inscrições | `api/contract.sources.test.ts` | conforme |
| Acesso | participante não vê nem acessa `/organizador` | `routing.test.tsx` | conforme |

## Fase A1 (Eventos e Inscrições)
| Requisito | Caso | Arquivo | Esperado |
|---|---|---|---|
| Catálogo | lista sem token, carregando, vazio, busca, link com `?q&page`, paginação, período ISO e inválido, erro + tentar de novo, 503 | `EventsPage.test.tsx` | conforme |
| Detalhe | visitante (só capacidade), id inválido, 404, 500 com código de suporte, banner só https, evento cancelado, atividade encerrada/cancelada, `registration_open=false`, sem atividades | `EventDetailPage.test.tsx` | conforme |
| Inscrição | marca atividade já inscrita, ignora canceladas, vagas livres de Inscrições (com Bearer) e falha tolerada, `join_waitlist` false/true, esgotado, `ACTIVITY_FULL` revela lotação e oferece a lista de espera, `INVALID_EVENTS_CONTRACT` em português, clique repetido, 401 do Gateway, falha ao carregar inscrições | `EventDetailPage.test.tsx` | conforme |
| Minhas inscrições | nomes vindos de Eventos, falha de Eventos, prazo, confirmação ao cancelar, aceitar oferta, estados encerrados sem ações, erro em português, 401, rede, paginação | `MyRegistrationsPage.test.tsx` | conforme |
| Início e menu | atalhos por papel, menu por sessão | `HomePage.test.tsx` | conforme |
| Erros | tradução por código, formato de Inscrições (`title`=`code`), código desconhecido, campo em inglês | `api/errors.test.ts` | conforme |
| APIs | URLs (`/events/api/v1`), métodos, corpo, token só quando exigido, disponibilidade, schemas no formato real e recusa do formato antigo de Eventos | `api/domainApis.test.ts` | conforme |
| Contrato | rotas chamadas existem no código de Eventos (resolvendo o prefixo `API`) e de Inscrições; kinds do Gateway | `api/contract.sources.test.ts` | conforme |
| Datas e valores | ISO x Python, período, preço, UUID | `components/format.test.ts` | conforme |
