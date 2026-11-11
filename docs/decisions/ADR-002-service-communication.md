# ADR-002 — Comunicação entre serviços

- **Status:** Aprovado
- **Detalhes de implementação:** Gateway e identidade em [DT-03](../architecture/technical-decisions.md), tópicos em [DT-05](../architecture/technical-decisions.md), contrato de Inscrições e Pagamentos em [DT-09](../architecture/technical-decisions.md)

## Contexto
Os serviços precisam interagir para cumprir os fluxos da aplicação, e cada interação tem uma exigência diferente.

## Alternativas consideradas
1. REST síncrono.
2. Mensageria assíncrona.
3. Modelo híbrido.

## Decisão
Adotar o **modelo híbrido**, com o Gateway como única porta de entrada REST, responsável por validar o JWT, enquanto os serviços realizam a autorização.

A comunicação REST entre serviços é restrita a consultas imediatas, com descoberta pelo service-discoverer. Para fatos de domínio usa-se Kafka, em um **modelo declarativo**: cada serviço publica os seus próprios eventos e os demais reagem a eles. Não há comandos entre serviços. A confiabilidade é garantida pelo **Transactional Outbox**.

## Evidências
1. Requisitos: RF04 (consulta), RF05 a RF07 (inscrição, espera e pagamento), RF08 (notificações), RF09 a RF11 (check-in, certificados e relatórios).
2. Regras de negócio: RN01 a RN03 (vaga e pagamento), RN05 (notificações desacopladas), RN06 (certificados só com presença) e RN07 (acesso).
3. Restrições: Kafka como broker único (KRaft, um nó), serviços em tecnologias diferentes, equipe pequena e prazo acadêmico.

## Justificativa
Só REST faria Notificações, Relatórios e Certificados entrarem no caminho crítico, e a queda de qualquer um deles travaria a inscrição, contrariando RN05 e RQ03. Só mensagens deixariam o usuário sem resposta nas consultas e na tentativa de inscrição, e complicariam a leitura sem necessidade.

## Consequências
**Positivas:** resiliência, menor acoplamento entre Inscrição e Pagamentos, evolução independente, escala seletiva e segurança.

**Negativas:** acoplamento síncrono residual (por exemplo, Inscrições consulta Eventos antes de reservar), complexidade operacional e dependência da evolução dos contratos.
