# ADR-003 — Gateway, descoberta e health check

- **Estado:** Health check, descoberta e contrato do Gateway: **Aprovado** (lidos do código do repositório). Porta pública do Gateway: pendente (P1).
- **Data:** 2026-10-30

## Contexto
O repositório define um `service-discoverer` (Go) com libs cliente e exige `GET /healthcheck` com 2xx. O Gateway foi implementado depois da primeira versão deste ADR e foi lido em `b0753be`. O frontend só deve conhecer a URL pública do Gateway.

## Decisão
1. **Health check em `/healthcheck`** (e não `/actuator/health`): Actuator com `management.endpoints.web.base-path=/` e `management.endpoints.web.path-mapping.health=healthcheck`, sem detalhes e sem expor outros endpoints. O grupo de saúde inclui o banco: se o banco cai, a instância sai da descoberta. A consulta é leve (validação de conexão).
2. **Registro no discoverer** com a lib Java existente (`Discovery.register(Kind.USER)`), usando `SERVICE_HOST` e `PORT`. Executado em segundo plano na inicialização, com falha apenas registrada em log: indisponibilidade do discoverer não impede o serviço de iniciar nem de atender requisições (RQ03).
3. O serviço de Usuários **não consulta** outros serviços (não precisa de nenhum), logo não usa `consult`/`request`.
4. **Consumo da lib:** ela não é publicada em repositório Maven. Proposta: `build.additional_contexts` na entrada `user:` do compose raiz e `mvn install` da lib em um estágio do Dockerfile. Alternativa, se a equipe preferir não editar o compose raiz: copiar a lib para dentro de `user/` (duplicação).
5. **Frontend → Gateway:** URL em `VITE_API_BASE_URL`; sem endereços internos. Rotas propostas em `contracts-with-team.md`.
6. **Gateway não implementado** nesta entrega.

## Alternativas
- Manter `/actuator/health`: quebra o contrato do discoverer.
- Duas rotas de health: duplicação sem necessidade.
- Falhar a inicialização se o registro falhar: acopla a disponibilidade ao discoverer.

## Consequências
- Sem porta publicada no host e sem Gateway, não há como testar o fluxo fim a fim até o Gateway existir.
- A lib Java `register` bloqueia por até ~5 s (5 tentativas): por isso roda em thread própria.

## Atualização após o merge do Gateway (2026-10-31)
- **Prefixo e registro:** o Gateway remove `/user` e registra as rotas lendo `GET /openapi.json`; o serviço o publica via springdoc (gerado do código, logo sempre igual às rotas reais). Endpoints nascem privados; `user/scripts/register-gateway-routes.sh` os abre.
- **Correlação:** adotado `X-Request-Id` (o do Gateway) em vez de `X-Correlation-Id`; valor recebido só é aceito com formato seguro.
- **CORS:** o Gateway responde preflights e **remove** `Access-Control-*` do serviço; configurar CORS em Usuários seria código morto. Decisão: Usuários não configura CORS. (Exigência do prompt de restringir origens fica com o Gateway: P14.)
- **Identidade:** o `X-User-Id` do Gateway não é verificado (P3). Usuários ignora esse cabeçalho e usa somente o `sub` do JWT; por isso `requireAuth` fica `false` nas rotas de Usuários.
- **Re-registro:** o registry do discoverer é em memória e descarta hosts sem saúde; a instância chama `register` a cada 30 s (idempotente), sem bloquear o início.
