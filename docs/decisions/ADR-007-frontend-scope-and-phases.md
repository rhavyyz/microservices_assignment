# ADR-007 — Frontend da aplicação inteira: escopo por fases e decisões da fase A1

- **Estado:** Aceito
- **Data:** 2026-11-05

## Contexto
O frontend nasceu só com Usuários (ADR-006). Desde então os outros serviços ganharam API real; inventário em 2026-11-05:

| Serviço | API para o frontend | Fonte do contrato |
|---|---|---|
| Eventos | catálogo público, detalhe, atividades, CRUD do organizador, publicar/cancelar, encerrar atividade | `events/src/http/schemas.ts`, `routes.ts` |
| Inscrições | criar, vagas, listar, cancelar, aceitar oferta, participantes, check-in | `subscription/app/api.py` |
| Pagamentos | consultar pagamento, simular (demonstração) | `payments/README.md` |
| Notificações | listar, marcar como lida, WebSocket | `README.md` raiz |
| Relatórios | métricas do organizador | `reports/README.md` |
| Certificados | lista e PDF do dono (`/certificates/me`, `/certificates/{id}`) | `docs/integration/contracts-with-team.md` §4c |

Todos declaram as configurações de Gateway (`x-gateway`: público ou não, `requireAuth`) no próprio OpenAPI.

## Decisão: fases
Cada fase conecta somente endpoints com contrato e é entregue com testes.
- **A1 (esta):** shell com menu, Início, catálogo e detalhe de Eventos, inscrição por atividade, Minhas inscrições.
- **A2 (entregue):** área do organizador: meus eventos (criar, editar, publicar, cancelar), atividades, participantes e check-in.
- **B (entregue):** Pagamentos (situação da cobrança) e Notificações (lista, marcar como lida, tempo real).
- **C (entregue):** Relatórios do organizador e Certificados (lista e download do PDF).

## Decisões da fase A1
1. **O catálogo é público e chamado sem token.** As leituras públicas de Eventos são `requireAuth=false`, e uma sessão expirada não deve quebrar a navegação.
2. **Erros de Eventos e Inscrições são traduzidos pelo código** (`CODE_MESSAGES`). Eventos responde em inglês e Inscrições manda só o código em `title`, sem `detail`. Mensagens de campo desses serviços viram "Valor inválido."; nada técnico chega à tela. O serviço de Usuários segue mostrando a mensagem em português do próprio servidor.
3. **Vagas livres vêm de Inscrições, não de Eventos.** Eventos guarda só a capacidade; Inscrições é o único contador (`GET /activities/{id}/availability`, que exige login). Autenticado: "12 de 30 vagas". Visitante, ou se a consulta falhar: "30 vagas no total", e o servidor decide na hora da inscrição.
4. **Botão de inscrição, em ordem:** já inscrito → mostra a situação; `registration_open=false` → mensagem pelo `lifecycle` ("Atividade cancelada/encerrada" ou "Inscrições encerradas"); visitante → "Entre para se inscrever"; sem vagas e com lista de espera → "Entrar na lista de espera" (`join_waitlist=true`); sem vagas e sem lista → "Esgotado"; senão "Inscrever-se" (`join_waitlist=false`: nunca entra em fila sem a pessoa pedir). Se o servidor responder `ACTIVITY_FULL` (as vagas acabaram depois de a página carregar), a tela passa a oferecer a lista de espera.
5. **Nomes das atividades em "Minhas inscrições"** vêm de Eventos (`GET /activities/{id}`), uma chamada por atividade distinta, com `allSettled`: se Eventos falhar, a inscrição aparece com identificação curta.
6. **Datas:** Inscrições serializa com `str(datetime)` do Python ("2026-11-03 23:25:45+00:00"); `normalizeApiDate` converte para ISO. O V8 aceita o formato com espaço e o Safari não, por isso há teste direto da função.
7. **Início (`/inicio`) é o destino pós-login.** Visitantes chegam ao catálogo (`/`). O menu mostra só o que existe. Banner de evento só com URL `https`, sem referrer.
8. **Rastreio:** o Gateway e os serviços usam `X-Trace-Id` (antes `X-Request-Id`, ainda aceito como fallback). A mensagem de erro mostra o `traceId` do corpo quando existe.

## Decisões da fase A2 (área do organizador)
1. **Só o papel ORGANIZER vê a área** (`/organizador/...`, menu "Meus eventos"). É só experiência de navegação: quem autoriza é o serviço (dono do evento; Eventos responde 403/404 a outro usuário).
2. **Rascunho exige token na leitura.** `getEvent` aceita `auth: true`; a página de gestão o usa, porque Eventos só mostra rascunho ao dono. O catálogo público continua sem token.
3. **A interface espelha as regras que o serviço aplica, mas o serviço decide:** evento cancelado não edita nem recebe atividade; atividade encerrada/cancelada não edita; **capacidade é imutável** (campo só leitura e nunca enviado no PATCH); **preço só muda em rascunho** (campo só leitura depois); **remover atividade só em rascunho**; **encerrar só depois do término previsto**; publicar exige ao menos uma atividade (a mensagem do serviço é traduzida). Toda ação destrutiva (cancelar evento, remover atividade) pede confirmação.
4. **Formulários em texto, conversão na saída:** datas `datetime-local` (horário local) viram ISO 8601 em UTC; o preço em reais vira `amount_minor` por aritmética de texto (sem ponto flutuante); campos opcionais vazios viram `null`. Banner só `https`.
5. **Participantes:** `GET /activities/{id}/registrations` (organizador) + nome/e-mail por busca de usuários por id. Se a busca falhar, mostra o id curto. O check-in só é oferecido a inscrição `CONFIRMED` durante a atividade; o serviço devolve 409 fora disso (traduzido).

## Decisões da fase B (Pagamentos e Notificações)
1. **Pagar parte de "Minhas inscrições":** só inscrição `PENDING_PAYMENT` tem "Pagar". O cliente envia **apenas** `registration_id` a `POST /payments/payments`; valor, moeda e dono vêm de Inscrições. A criação é idempotente, então voltar à tela devolve o mesmo pagamento.
2. **Tela do pagamento (`/pagamentos/:id`):** mostra valor, situação, prazo e o que aconteceu com a vaga. Enquanto `PENDING`, consulta a cada 4 s e para ao chegar a um estado final (a aprovação chega por Kafka, de forma assíncrona). Depois de aprovado, a inscrição pode levar instantes para constar como confirmada, e a tela diz isso.
3. **Provedor simulado:** os botões aprovar/recusar/expirar só aparecem com o pagamento pendente e são rotulados como demonstração. Se o serviço o desligar (`SIMULATOR_ENABLED=false`), responde 404 e a tela mostra a mensagem traduzida. `409 PAYMENT_NOT_APPLIED` recarrega o estado real.
4. **Notificações em tempo real pelo WebSocket do Gateway** (`GET /ws?access_token=…`). O navegador não envia cabeçalho em WebSocket, então o token vai na query; o Gateway não registra a query, mas **isso exige TLS em produção** e token de vida curta. Há uma conexão por usuário (a mais nova vence): o código `4000` (substituída por outra aba) **não** reconecta, para duas abas não se derrubarem; qualquer outra queda reconecta com espera crescente (1 s … 30 s). Quadros desconhecidos ou inválidos são ignorados. Como reserva, o contador é consultado a cada 30 s.
5. **Contador do menu:** não lidas = status `DEFAULT` ou `RECEIVED` (até 100; mostra "100+"). Um push é contado uma vez por id, e uma consulta em andamento é descartada se um push chegar no meio (o resultado dela é anterior a ele).
6. **Links das notificações só para destinos internos conhecidos,** montados do `payload` (`payment` com `payment_id` UUID → `/pagamentos/:id`; tipos `Registration*`/`Waitlist*` → `/inscricoes`). O `redirect_url` do serviço **não é usado**: nenhum produtor o preenche hoje e um endereço vindo de fora não deve virar link.
7. **Marcar como lida** usa `PUT /notifications/update-state` (lote ≤ 100). Resposta parcial (`errors`) é tratada: só o que foi atualizado muda na tela e a falha é informada.

## Decisões da fase C (Relatórios e Certificados)
1. **Relatório (`/organizador/eventos/:id/relatorio`)** usa `GET /reports/events/{id}/summary` e a lista paginada `…/activities`. O link só aparece para evento **não rascunho** (rascunho não tem indicadores). Quem não é dono recebe 404 `EVENT_NOT_FOUND` do serviço e a tela mostra "não encontrado" (o serviço não distingue inexistente de alheio, e a tela também não).
2. **Os números são eventualmente consistentes:** o serviço de Relatórios monta um modelo de leitura a partir do Kafka. A tela tem "Atualizar" e avisa que podem atrasar em relação às outras telas.
3. **Dinheiro nunca é somado entre moedas:** valores são inteiros em unidades menores, exibidos por moeda (`Intl` pt-BR); moeda desconhecida (`UNKNOWN`) aparece como "15,00 UNKNOWN" em vez de quebrar. Zero é um valor, não ausência.
4. **Taxas** (0–1) viram "75,0%"; `null` (denominador zero) vira "—", nunca "0%".
5. **Certificados (`/certificados`)** lista `GET /certificates/api/v1/certificates/me` (página de 50; "Próxima" só quando a página veio cheia, pois o serviço não devolve total). O título do evento vem do catálogo público; `event_id` nulo (certificados antigos) mostra identificação curta. Não há botão de emitir: o certificado nasce de `AttendanceEligible` (evento encerrado e ≥ 75% de presença), e o estado vazio explica isso.
6. **Download do PDF exige Bearer**, então um link `<a href>` não serve: o cliente baixa por `fetch` como Blob (`requestBlob`, que exige `Content-Type: application/pdf`, senão `INVALID_RESPONSE`) e salva como `certificado-<id>.pdf` por um endereço temporário liberado logo em seguida. 404 vira "não encontrado"; 503 (arquivo ainda indisponível) é traduzido.

## Detecção de divergência de contrato
Testes leem o **código-fonte** dos serviços (rotas de Eventos, com o prefixo `API`, e de Inscrições; nomes dos serviços no Gateway) e conferem que toda rota que o cliente chama existe. Isso já se pagou: depois de atualizar o `main`, Eventos passou a servir tudo sob `/api/v1`, renomeou `id`→`event_id`/`activity_id`, `price_cents`→`amount_minor` e removeu `available`; o teste acusou na hora, e o cliente foi reescrito antes de entregar.

## Consequências
- **P21 (Inscrições × Eventos) está resolvida no código:** Eventos agora implementa `GET /api/v1/activities/{id}` e `/permissions/me` no formato que Inscrições consome. **Não foi validada de ponta a ponta** (sem Docker no ambiente de desenvolvimento): a inscrição só foi testada com respostas simuladas.
- A interface depende do contrato atual de Eventos; mudanças nele quebram os testes de contrato antes de quebrar a tela.
