# Contratos e dependências com a equipe

> Estado: **Fase 0/1** — inventário do repositório, contratos propostos e pendências.
> Legenda: **Aprovado** (já existe no repositório) · **Proposto** (sugestão desta entrega, aguardando confirmação) · **Pendente** (sem contrato; não foi inventado).

## 1. Inventário do repositório (commit `75d163d`)

| Item | Estado encontrado | Consequência para esta entrega |
|---|---|---|
| `service-discoverer/` | Implementado em Go (registro em memória). Libs cliente em Python, Go e **Java 17+ (sem dependências)** em `service-discoverer/Libs/`. | Aprovado. O serviço de Usuários usa a lib Java para se registrar com `Kind.USER`. |
| `user/` | Apenas `Dockerfile` placeholder (`alpine` + `sleep infinity`) e `docker-compose.yml` com o template de banco comentado (`postgres:16-alpine`, rede `user-net`). | Será substituído pelo serviço real (Fase 2). O template de Postgres será descomentado. |
| `gateway/` | Apenas placeholder. **Nenhuma rota, porta publicada ou contrato definidos.** | Contrato do Gateway **pendente** (seção 3). |
| `events/`, `subscription/`, `payments/`, `notifications/`, `reports/`, `certificates/` | Apenas placeholders. | Nenhum contrato disponível. Não serão simulados. |
| `docker-compose.yml` raiz | Kafka KRaft (`kafka:9092`), rede `backbone`; cada serviço com `deploy.replicas` e **sem portas no host**. | O serviço `user` já está em `[backbone, user-net]`. Sem porta no host, o acesso externo depende do Gateway (P1). |
| Frontend | **Não existe.** | Será criado em `frontend/` (Fase 6). |
| `.gitignore` | Continha `.env.*`, que **também ignorava `.env.example`**. | Ajuste mínimo: `!.env.example` (já aplicado). |

### Contrato de descoberta (Aprovado — lido do código)

- `POST /register` `{"kind":"user","host":"<host:porta>"}` → `204`.
- `GET /consult?kind=<kind>` → `200 {"host":"..."}`; `503` sem instância saudável; `400` kind inválido.
- Kinds válidos: `certificates, events, subscription, payments, user, notifications, reports`. **Gateway não é um kind.**
- O discoverer exige que o serviço exponha **`GET /healthcheck` com 2xx**, chamado a cada consulta; 5 falhas seguidas removem o host.
- Variáveis: `SERVICE_DISCOVERER_URL` (padrão `http://service-discoverer:8080`), `SERVICE_HOST`, `PORT`.

> **Divergência com o prompt:** o prompt sugere `/actuator/health`; o contrato aprovado exige `/healthcheck`. Prevalece o contrato do repositório (ver ADR-003).

## 2. Plano por fases

| Fase | Conteúdo | Verificável neste ambiente? |
|---|---|---|
| 0 | Inventário e plano | Sim |
| 1 | OpenAPI v1, ADRs, catálogo de contratos | Sim (validação do OpenAPI) |
| 2 | Backend: Spring Boot 4.1.x, Postgres, Flyway, entidades | **Não compila aqui** (Maven Central bloqueado) |
| 3 | Cadastro e perfil | Idem |
| 4 | Login, JWT RS256, Spring Security, JWKS | Idem |
| 5 | `/healthcheck`, auditoria, correlation ID, registro no discoverer | Idem |
| 6 | Frontend React/TS (cadastro, login, perfil) | Sim (npm funciona) |
| 7 | Integração com colegas | Depende dos contratos |
| 8 | Testes finais, relatório | Parcial |

Riscos: (a) backend sem compilação local — o código não será declarado testado até ser compilado em outro ambiente; (b) Gateway inexistente impede teste fim a fim; (c) várias réplicas do serviço exigem **chave de assinatura compartilhada** (ADR-001).

## 3. Pendências para a equipe

| # | Pergunta concreta | Proposta provisória | Quem confirma | Efeito na implementação |
|---|---|---|---|---|
| P1 | Qual a URL pública do Gateway em dev e qual porta será publicada no host? | Frontend lê `VITE_API_BASE_URL`; sem valor fixo no código. | Responsável pelo Gateway | Apenas configuração. |
| P2 | Mapeamento de rotas no Gateway para o kind `user` (tabela abaixo). | Ver tabela de rotas. | Responsável pelo Gateway | Frontend usa esses caminhos. |
| P3 | O Gateway valida o JWT ou apenas repassa `Authorization`? | Apenas repassa `Authorization` e `X-Correlation-Id`; cada serviço valida. | Gateway + todos os serviços | Nenhuma em Usuários. |
| P4 | CORS: tratado no Gateway ou no serviço? | Usuários permite só origens listadas em `USERS_CORS_ALLOWED_ORIGINS`; se o Gateway tratar, deixar vazio. | Gateway | Configuração. |
| P5 | Como os demais serviços obtêm a chave pública? | JWKS em `GET /.well-known/jwks.json`, localizado via `GET /consult?kind=user`. Alternativa: chave pública por configuração. | Todos os serviços | Define se o endpoint JWKS é usado. |
| P6 | Valor de `iss` e se haverá `aud`. | `iss=eventhub-users` (configurável), sem `aud`. | Todos os serviços | Configuração e validação nos consumidores. |
| P7 | Fluxo aprovado para criar `ORGANIZER` em produção. | Nenhum endpoint. Somente seed de dev (desativado por padrão). | Equipe/docente | Sem endpoint de promoção até decisão. |
| P8 | Usuários publica algum evento Kafka (ex.: `user.registered`)? | **Não.** Nenhum tópico criado. | Notificações + Usuários | Sem Kafka no serviço. |
| P9 | Certificados precisa do nome do participante: snapshot em Inscrições ou endpoint interno? | Nenhum endpoint criado. | Certificados + Inscrições | Nenhuma por ora. |
| P10 | Onde o frontend é servido e entra no `docker-compose` raiz? | Pasta `frontend/` com build estático; **compose raiz não alterado** até confirmação. | Equipe | Define o Dockerfile do frontend. |
| P11 | A lib Java de discovery está fora do contexto `./user`. | `build.additional_contexts` na entrada `user:` do compose raiz (ADR-003). | Equipe | Edição só na entrada `user:`. |
| P12 | Proteção contra força bruta/rate limit no login. | Fora do escopo; sugerida no Gateway. | Gateway | Limitação conhecida. |

### Rotas propostas no Gateway (P2) — **Proposto**

| Método | Caminho público | Destino (kind `user`) | Auth |
|---|---|---|---|
| POST | `/api/v1/auth/register` | `/api/v1/auth/register` | Não |
| POST | `/api/v1/auth/login` | `/api/v1/auth/login` | Não |
| GET, PATCH | `/api/v1/users/me` | `/api/v1/users/me` | Bearer |
| GET | `/.well-known/jwks.json` | idem | Não |

`/healthcheck` é de uso interno (discoverer/orquestrador) e **não** deve ser exposto publicamente.

## 4. Dependências por consumidor

| Consumidor | O que recebe de Usuários | Estado |
|---|---|---|
| Eventos | `sub` e `roles` do JWT; valida a responsabilidade pelo evento | Proposto |
| Inscrições | `sub` do token validado (nunca `userId` do corpo) | Proposto |
| Pagamentos | Referência via Inscrições, sem acesso ao banco de Usuários | Proposto |
| Notificações | Contrato de mensagem a definir (P8) | Pendente |
| Check-in | Valida inscrição no domínio proprietário | Proposto |
| Certificados | Ver P9 | Pendente |
| Relatórios | Sem dados pessoais de Usuários | Proposto |
