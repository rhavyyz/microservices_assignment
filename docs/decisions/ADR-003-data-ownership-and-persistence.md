# ADR-003 — Persistência e propriedade dos dados

- **Status:** Aprovada
- **Detalhes de implementação:** [technical-decisions.md](../architecture/technical-decisions.md) e `docs/architecture/platform-guide.md`

## Contexto
Os serviços guardam dados de que outros também precisam. É preciso decidir onde cada dado mora, quem é o dono, como os demais o acessam e que garantia de consistência vale quando dois serviços participam do mesmo fluxo.

## Alternativas consideradas
- Banco único compartilhado entre os serviços.
- Banco por serviço (*database per service*).
- Banco por serviço com transação distribuída (2PC).
- Banco por serviço com leitura direta do banco de outro serviço.

## Decisão
Cada serviço é dono exclusivo dos seus dados, em um armazenamento próprio e privado que nenhum outro serviço acessa. Dados de outro serviço chegam por API ou por evento no Kafka, sempre referenciados por identificador. A consistência entre serviços é **eventual** e se apoia em três mecanismos: Transactional Outbox, consumidor idempotente e invariantes no banco do dono do dado (constraints e bloqueio de linha).

## Evidências
- Requisitos: RQ01 (evolução independente), RQ02 (escalabilidade seletiva), RQ03 (disponibilidade), RQ04 (consistência, sem overbooking) e RQ05 (tecnologias distintas).
- Regras de negócio: RN01 (reserva de vaga), RN02 e RN03 (pagamento e confirmação), RN05 (notificações desacopladas).
- Implementação: cada pasta tem seu `docker-compose.yml` com a infraestrutura própria, e o guia da plataforma proíbe ler o banco de outro serviço.
- Outbox e consumidor idempotente em Eventos, Inscrição e Pagamentos. Consumidores deduplicam por `message_id` (tabela `processed_messages`) e Inscrição rejeita estados antigos com `aggregate_version`.

## Justificativa
Um banco compartilhado acoplaria os esquemas, impediria a implantação independente (RQ01) e faria uma consulta pesada de relatórios competir com as inscrições (RQ03). A transação distribuída exigiria todos os participantes no ar ao mesmo tempo, o que derrubaria a disponibilidade.

## Consequências
**Positivas:** esquema e implantação independentes, falha de banco isolada, escala separada por serviço, ausência de overbooking garantida por constraints e eventos que não se perdem e podem ser reprocessados com segurança.

**Negativas:** consistência eventual (a inscrição fica pendente até a resposta chegar e os relatórios podem estar atrasados), custo operacional de vários armazenamentos e aprovações tardias que exigem compensação por estorno.
