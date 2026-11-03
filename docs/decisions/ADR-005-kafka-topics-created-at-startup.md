# ADR-005 — Tópicos Kafka são criados pelo serviço que os usa, antes de consumir ou publicar

- **Estado:** Aceito (implementado em Inscrições e no Gateway; Notificações já fazia isso)
- **Data:** 2026-11-03

## Contexto
O Kafka do compose raiz cria tópicos automaticamente quando alguém publica, mas um consumidor que assinou um tópico **antes** de ele existir só o enxerga no próximo refresh de metadados do cliente. Em teste de ponta a ponta com a pilha real, o Inscrições (cliente librdkafka, padrão de 5 min) levou cerca de 3,5 min para reagir a um `ActivityCancelled` publicado logo após o início; com o tópico já conhecido, a reação levou cerca de 2 s. O Gateway mitiga com refresh de 30 s, mas também não cria o tópico.

## Decisão
1. **Todo serviço que consome ou publica em um tópico garante que ele existe antes de começar** (criação se ausente, na inicialização). A falha do Kafka não impede o serviço de iniciar: a garantia roda em segundo plano, com repetição e espera crescente (2 s até 30 s), e o consumo/publicação só começa depois dela.
2. **Só cria; nunca altera um tópico existente.** Sem aumentar partições nem mudar configuração, porque isso remapeia as chaves das mensagens e quebra a ordem por chave. (Notificações aumenta partições dos próprios tópicos; é uma exceção antiga e não deve ser copiada.)
3. **Partições padrão: 6**, o mesmo padrão de Notificações, para que quem criar primeiro crie o mesmo tópico. Cada serviço aceita uma variável de ambiente própria para o número (`SUBSCRIPTION_TOPIC_PARTITIONS`, `NOTIFICATIONS_PUSH_PARTITIONS`, `NOTIFICATIONS_PARTITIONS`). Replicação 1 (Kafka de nó único).
4. **Rede de segurança no consumidor:** o cliente de Inscrições confere novos tópicos a cada 10 s (`topic.metadata.refresh.interval.ms`), para o caso de um tópico ser criado por outra equipe depois.
5. Serviços ainda sem código (Eventos, Pagamentos, Relatórios, Certificados) devem seguir a mesma regra quando passarem a usar Kafka.

## Alternativas
- **Pré-criar os tópicos no compose ou em um serviço de inicialização:** centraliza, mas cria um novo componente e uma lista a manter em paralelo ao código; a regra "quem usa, garante" evita isso.
- **Confiar na criação automática do broker:** é o que causou a espera; além disso depende da configuração de cada ambiente.
- **Só reduzir o refresh de metadados:** reduz a espera para segundos, mas não garante que o tópico exista antes da primeira publicação. Adotado apenas como rede de segurança.

## Consequências
- Um tópico pode ser criado por qualquer um dos serviços que o usam; vale quem chegar primeiro, por isso o padrão de partições deve ser igual.
- Em ambientes com a criação por administrador (ACL), o usuário do serviço precisa de permissão para criar tópicos, ou os tópicos devem ser criados antes por infraestrutura (a garantia então só confirma que existem).
- A lista de tópicos e quem produz/consome está em `docs/integration/contracts-with-team.md`.
