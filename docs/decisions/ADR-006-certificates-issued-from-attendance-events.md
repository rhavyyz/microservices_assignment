# ADR-006 — Certificados são emitidos somente a partir de eventos de presença

- **Estado:** Aceito (implementado em Certificados)
- **Data:** 2026-11-04
- **Resolve:** P9 de `docs/integration/contracts-with-team.md` (nome do participante)

## Contexto
O serviço de Certificados já tinha a regra de elegibilidade (presença mínima de 75% e atividade encerrada), o gerador de PDF e a persistência, mas nada os acionava. Faltava decidir **quem dispara a emissão**, **de onde vem o nome do participante** e **onde os PDFs ficam guardados**. Inscrições já publica `subscription.events` com um evento `AttendanceEligible` (pelo menos um check-in válido, emitido somente após o fim da atividade).

## Decisão
1. **Certificados só são criados ao consumir `AttendanceEligible` de `subscription.events`** (grupo `certificates-service`, confirmação manual do offset depois do processamento). **Não existe endpoint de criação.** Qualquer outro tipo de evento, inclusive desconhecido, é confirmado e ignorado.
2. **O serviço faz validações próprias, sem confiar cegamente no evento:** busca a atividade e o evento em Eventos (`GET /activities/{id}`, `GET /events/{id}`), exige que a atividade tenha terminado (`agora >= ends_at`), busca o nome do participante em Usuários e só então aplica a regra de elegibilidade. Como o evento não traz percentual e o critério de Inscrições é "ao menos um check-in válido", a regra recebe presença = 100.
3. **Idempotência:** `registration_id` é único; um evento repetido (entrega pelo menos uma vez) ou uma corrida de inserção resulta em sucesso, sem segundo certificado.
4. **Falhas:** mensagem inválida (JSON, ids, `schema_version != 1`), atividade ou usuário inexistente e inelegibilidade são **venenosas**: grava-se em `certificates.dlq` apenas uma referência (tópico, partição, offset, motivo, sem dados pessoais) e confirma-se o offset. Falha de dependência, atividade ainda não encerrada ou erro inesperado são **transitórios**: não confirma, volta ao mesmo offset e repete com espera crescente (2 s até 30 s). A thread do consumidor nunca encerra.
5. **Nome do participante** vem de um endpoint **interno e sem autenticação** de Usuários, `GET /internal/users/{id}`, que devolve **somente `id` e `name`**. A proteção é o isolamento de rede (como os demais `/internal/...`, ver ADR-003); ele **nunca é registrado no Gateway**.
6. **Armazenamento dos PDFs** atrás de uma interface (`save_pdf`/`read_pdf`/`delete_pdf`, chaves opacas `<uuid>.pdf`) com dois backends: sistema de arquivos local (padrão em código e nos testes) e **S3 compatível (SeaweedFS no compose)**, escolhido por `CERTIFICATE_STORAGE_BACKEND`. O compose usa SeaweedFS (gateway S3 na porta 8333) privado, sem porta no host, com credenciais sem valor padrão, gravadas no arquivo de identidades S3 na inicialização do contêiner. O MinIO foi a primeira escolha, mas a imagem `minio/minio` deixou de ser publicada (a comunidade não recebe mais imagens oficiais, e o tag fixado não pode ser baixado); o SeaweedFS (`chrislusf/seaweedfs`) foi adotado por ser um armazenamento compatível com S3 e mantido. Como o acesso continua atrás da interface `BlobStorage`, o backend pode ser trocado sem mudar o domínio.
7. **API pública (atrás do Gateway):** apenas `GET /api/v1/certificates/me` e `GET /api/v1/certificates/{id}`. A identidade vem de `X-User-Id` (ADR-003); o PDF só é entregue ao dono, e o de outro usuário responde `404` igual ao inexistente. Cada certificado guarda `user_id` e `activity_id` (migração nova, colunas anuláveis porque as linhas antigas não podem ser preenchidas).
8. Os tópicos `subscription.events` e `certificates.dlq` são garantidos pelo próprio serviço antes de consumir (ADR-005).

## Alternativas rejeitadas
- **Endpoint HTTP de criação (chamado por Inscrições ou pelo front):** exigiria autorização de serviço a serviço, que não existe, e permitiria emitir sem presença válida; também acopla a disponibilidade de Certificados à de Inscrições.
- **Nome do participante dentro do evento:** espalha dado pessoal por um tópico retido e relido, e o nome pode mudar; o dono do dado é Usuários.
- **Busca de usuários (`GET /api/v1/users`):** exige token de organizador e expõe nome e e-mail, muito além do necessário (ver P18).
- **Confiar no evento sem consultar Eventos:** um evento adulterado ou antecipado emitiria certificado para atividade que não terminou.
- **Manter o PDF só em volume local:** não é compartilhável entre réplicas nem sobrevive à recriação do contêiner de forma explícita.

## Consequências
- Usuários precisa expor `GET /internal/users/{id}` e Eventos precisa expor `GET /activities/{id}` e `GET /events/{id}` (contrato em `docs/integration/contracts-with-team.md`).
- O endpoint interno depende do isolamento de rede: um contêiner dentro da rede pode consultar o nome de qualquer usuário pelo id. Risco aceito, restrito a `id` e `name`.
- Uma mensagem que depende de serviço indisponível é repetida indefinidamente e bloqueia a partição atrás dela; prioriza-se não perder um certificado.
- O percentual de presença fixo em 100 deve ser revisto se Inscrições passar a enviar um percentual.
- Em ambientes que não sejam de desenvolvimento, o armazenamento S3 deve usar chave de acesso própria, não a raiz.
