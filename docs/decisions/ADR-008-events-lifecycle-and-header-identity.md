# ADR-008 — Eventos encerra atividades e segue o contrato de Inscrições

- **Estado:** Aceito (implementado em Eventos e Inscrições)
- **Data:** 2026-11-05

## Contexto
Eventos e Inscrições tinham modelos de vagas e contratos incompatíveis: Eventos reservava assentos (saga de reserva por Kafka, `reserved`, `seat_reservations`), validava o JWT por conta própria e usava nomes e formatos próprios (`id`, `price_cents`, rotas sem `/api/v1`), enquanto Inscrições contava as vagas, confiava nos cabeçalhos do Gateway e esperava `activity_id`, `event_id`, `amount_minor`+`currency` e um envelope plano. Além disso, os certificados nunca eram emitidos porque nada encerrava uma atividade: Inscrições só avalia presença quando recebe `ActivityEnded`, e ninguém o publicava.

## Decisão
1. **Eventos guarda só a capacidade máxima e Inscrições conta as vagas.** Eventos não reserva assentos e não consome Kafka.
2. **Eventos publica `ActivityEnded`/`ActivityCancelled` em `events.events`.** O encerramento manual é feito pelo organizador via `POST /api/v1/activities/{activity_id}/end`, somente depois de `ends_at`; o automático ocorre após `ACTIVITY_AUTO_END_AFTER_SECONDS` (padrão 86400) do `ends_at`. O cancelamento de um evento cancela suas atividades.
3. **Identidade só por `X-User-Id`/`X-User-Roles`,** sem validar JWT em Eventos (o `Authorization` é ignorado), como nos demais serviços atrás do Gateway (ADR-003).
4. **Nomes e formato seguem Inscrições:** prefixo `/api/v1`, `activity_id`/`event_id`, `amount_minor`+`currency`, e envelope plano com `message_id`, `schema_version`, `type` PascalCase, `occurred_at` e `trace_id`. Eventos também publica `EventCreated`, `EventUpdated`, `EventPublished`, `EventCancelled`, `ActivityCreated`, `ActivityUpdated` e `ActivityDeleted`; a chave é `activity_id` em `ActivityEnded`/`ActivityCancelled` e `event_id` nos demais. Inscrições trata só os dois tipos de ciclo de vida, ignora os outros (confirmados sem DLQ) e ignora campos extras na resposta de `GET /api/v1/activities/{activity_id}`.

## Alternativas
- **Manter a saga de reserva em Eventos:** duas fontes de verdade para as vagas e um contrato Kafka a mais para manter em sincronia com Inscrições.
- **Inscrições derivar o fim da atividade de `ends_at`:** esconderia o encerramento em um relógio de Inscrições, sem permitir ao organizador encerrar nem publicar o fato para outros consumidores (Certificados, Relatórios).

## Consequências
- Relatórios ainda lê o formato antigo de Eventos e deixa de projetar eventos/atividades até ser adaptado.
- Certificados passa a ler `event_id`.
- As colunas legadas `reserved` e a tabela `seat_reservations` permanecem sem uso em Eventos.
- Inscrições passa a receber todos os tipos de `events.events`; um novo tipo publicado por Eventos não exige mudança em Inscrições nem gera DLQ, mas só `ActivityEnded`/`ActivityCancelled` têm efeito.
