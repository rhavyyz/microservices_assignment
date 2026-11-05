# ADR-007 — Inscrições é declarativa; Pagamentos reage aos eventos

- **Estado:** Aceito (implementado em Inscrições; Pagamentos adota o mesmo contrato)
- **Data:** 2026-11-05

## Contexto
Inscrições dava ordens a Pagamentos: publicava comandos em `payments.commands` (`PaymentRequested`, `PaymentCancelRequested`, `PaymentRefundRequested`), mantinha uma tabela local de tentativas financeiras (`payment_attempts`) com versão do provedor, chave de idempotência e um job de reconciliação que consultava `GET /internal/payment-attempts/{id}` em Pagamentos. Isso acoplava os dois serviços: Inscrições precisava conhecer o ciclo de vida financeiro (cancelamento pendente, estorno pendente), e Pagamentos precisava guardar e expor um histórico versionado só para Inscrições reconciliar. Inscrições já publica eventos de domínio completos em `subscription.events`, suficientes para Pagamentos decidir sozinho.

## Decisão
1. **Inscrições é declarativa:** só emite eventos de domínio e não envia comandos nem chama Pagamentos. Entrou em `PENDING_PAYMENT` (inscrição paga ou aceite de oferta paga) emite o novo `RegistrationPendingPayment`, sem campos extras.
2. **Pagamentos reage:** consome `subscription.events`, cancela a cobrança pendente ou estorna a aprovada ao ver `RegistrationCancelled`/`RegistrationExpired`. Ignora `RegistrationPendingPayment`: a cobrança não nasce de evento.
3. **Criação via HTTP com consulta:** a cobrança é criada por `POST /payments` (só com o `registration_id`; a identidade vem de `X-User-Id`). Pagamentos lê os fatos (valor, moeda, prazo, evento, estado) em `GET /internal/registrations/{registration_id}` de Inscrições, rota interna sem autenticação (isolamento de rede), fora do OpenAPI e do Gateway. Para servir o evento, a inscrição passa a gravar o id do evento (migração `004`, coluna `parent_event_id`, renomeada para `event_id` na `006`).
4. **Pagamentos tem a própria expiração** da cobrança, independente da de Inscrições.
5. **Sem reconciliação:** removidos `payments.commands`, `payment_attempts` (migração `004` a elimina), `idempotency_key`, `payment_attempt_id`, `provider_version`, o job de reconciliação e `RECONCILE_SECONDS`.
6. **Inscrições aplica regras sobre `payments.events`** (deduplicado por `message_id`, campos extras ignorados): `PaymentApproved` confirma só se a inscrição está `PENDING_PAYMENT`, dentro da reserva (relógio do banco) e com valor/moeda iguais ao snapshot, senão é ignorado; `PaymentDeclined` rejeita e promove a fila; `PaymentCreated`, `PaymentExpired`, `PaymentCancelled` e `PaymentRefunded` são informativos; `registration_id` desconhecido é ignorado.

## Alternativas
- **Manter comandos e reconciliação:** funciona, mas mantém o acoplamento e duas fontes do estado financeiro.
- **Incluir valor, moeda e prazo no evento `RegistrationPendingPayment`:** dispensaria o HTTP, mas congela o formato do evento para o consumo de Pagamentos; a consulta devolve sempre o estado atual.
- **Eventos como única fonte, sem endpoint:** exigiria que Pagamentos reconstruísse o estado das inscrições a partir de todo o histórico.

## Consequências
- Uma aprovação tardia (depois de cancelamento, expiração ou fora do prazo) não confirma nada em Inscrições; Pagamentos a estorna por conta própria depois de ver o evento de cancelamento/expiração.
- O timer de reserva de Inscrições é a autoridade sobre a vaga; os eventos de expiração/cancelamento de Pagamentos não liberam vaga.
- Pagamentos passa a depender da disponibilidade do endpoint interno de Inscrições para criar cobranças, e do isolamento de rede como única proteção dele.
- Não há endpoint de reconciliação financeira: uma mensagem de `payments.events` perdida não é recuperada por consulta. A garantia de entrega é a da outbox/Kafka (pelo menos uma vez); uma aprovação perdida deixa a inscrição expirar pelo timer e Pagamentos estorna.
- Inscrições deixa de expor `payment.status` na leitura individual da inscrição.
