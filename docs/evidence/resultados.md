# Resultados da validação

Execução de 12/11/2026, em uma máquina Linux (Ubuntu), com Docker Compose, a partir do commit `196853c` da `main`
(veja [`logs/00-commit.txt`](logs/00-commit.txt)). Os logs completos estão em [`logs/`](logs/). Caminhos locais foram trocados por `<repo>`.
Para reproduzir, siga [`../running.md`](../running.md).

## 1. Testes automatizados

| Serviço (tecnologia) | Resultado | Log |
|---|---|---|
| Frontend (React, Vitest) | 297 testes em 27 arquivos passaram, com lint, tipos e build limpos | `01-frontend.txt` |
| Usuários (Java, Spring) | `BUILD SUCCESS`: 53 testes unitários e 47 de integração, 0 falhas, 0 ignorados | `02-user-verify.txt` |
| Eventos (Node) | 74 passaram | `03-events.txt` |
| Pagamentos (Node) | 67 passaram | `03-payments.txt` |
| Relatórios (Node) | 63 passaram | `03-reports.txt` |
| Inscrições (Python, PostgreSQL real) | 182 passaram, 0 ignorados, ruff sem avisos | `06-subscription.txt` |
| Certificados (Python) | 209 passaram | `05-certificates.txt` |
| Gateway, Notificações, service-discoverer e lib Go | todos `ok` | `04-go.txt` |

Total: 992 testes (297 + 100 + 74 + 67 + 63 + 182 + 209) mais 4 pacotes Go, sem falhas.

## 2. Teste de concorrência (RN01, RQ04)

Executado com `TEST_DATABASE_URL` apontando para um PostgreSQL real, de modo que nenhum teste de banco ficou `skipped`
(`logs/07-concorrencia.txt`: 42 selecionados, 42 passaram).

| Teste | O que prova |
|---|---|
| `test_hundred_concurrent_requests_ten_seats` (com preço 0 e 1500) | 100 solicitações simultâneas para 10 vagas nunca ocupam mais de 10, em atividade gratuita e paga |
| `test_concurrent_requests_same_user_single_registration` | o mesmo usuário, em paralelo, fica com uma única inscrição |
| `test_expiry_and_payment_race` | expiração da reserva e aprovação ao mesmo tempo não geram confirmação indevida |
| `test_cancel_and_payment_race` | cancelamento e pagamento ao mesmo tempo ficam consistentes |
| `test_concurrent_end_of_last_activities_emits_once` | o evento de elegibilidade a certificado é emitido uma só vez |

Mecanismo: a reserva é feita sob bloqueio da atividade no banco de Inscrições, com constraints de capacidade.

## 3. Fluxo ponta a ponta com a pilha no ar

`logs/09-compose-ps.txt`: 18 containers no ar, com os bancos `healthy`; `/docs` do Gateway responde 200.
`logs/10-demo-seed.txt` (`scripts/demo-seed.sh`) percorreu: cadastro, aprovação de organizador pelo ADMIN, criação e publicação de evento,
inscrição `PENDING_PAYMENT`, pagamento simulado aprovado e inscrição `CONFIRMED`. Passam por Gateway, Usuários, Eventos, Inscrições e Pagamentos
(Java, Node, Python e Go na mesma requisição de ponta a ponta), com Kafka e Notificações no caminho assíncrono.

## 4. Falhas de dependência (`logs/11-falhas.txt`)

| Cenário | Esperado | Observado |
|---|---|---|
| A. Pagamento recusado (`simulate` com `decline`) | pagamento `DECLINED`, inscrição `REJECTED`, vaga liberada | `status: DECLINED` e depois inscrição `REJECTED`, `expires_at: null` |
| B. Eventos indisponível (`docker compose stop events`) | `503` e nenhuma reserva | `503 DEPENDENCY_UNAVAILABLE` com `X-Trace-Id` `7f565802...`, o mesmo id registrado nos logs do Gateway e de Inscrições (`12-logs-fluxo.txt`) |
| C. Notificações indisponível (`stop notifications`) | inscrição criada normalmente (RN05) | `201 Created`, inscrição `CONFIRMED` |

Depois de cada falha o serviço foi religado e a pilha voltou a responder.

## 5. Rastreabilidade (RQ06)

Cada resposta traz `X-Trace-Id`, que também aparece nos logs de acesso do Gateway e de Inscrições e nos eventos publicados pelas outbox.
Exemplo: o 503 do cenário B pode ser seguido nos dois serviços pelo mesmo id.

## 6. Observações e limites

- Nos logs de inicialização aparecem erros de `kafkajs` (`ECONNREFUSED` e `Topic creation errors`). São tentativas enquanto o Kafka sobe ou criação de
  tópicos que já existem. Os serviços se recuperam sozinhos e o fluxo funcionou em seguida.
- O teste de falha do Kafka (parar o broker) e o de expiração por prazo (esperar 900 s) não foram executados nesta rodada. Eles são cobertos por testes
  automatizados (`test_outbox_survives_kafka_failure`, `test_payment_after_expiry_is_ignored`) e não por execução com a pilha.
- O teste de concorrência é de serviço com banco real, não de carga HTTP pelo Gateway.
- O `pytest` de Inscrições avisa que `httpx` está obsoleto em favor de `httpx2` (apenas aviso).
