# Validação da implementação

Data: 2026-11-01 (America/Sao_Paulo).

## Resultado

- `python -m pytest -q`: **33 passed, 1 warning**, em 21,18 segundos; nenhum teste pulado.
- `ruff check app tests scripts`: **All checks passed**.
- `docker compose -f docker-compose.yml -f subscription/compose.integration.yml config --quiet`:
  válido, com variáveis de configuração de teste. Não iniciou contêineres.
- Formatação aplicada com Ruff.

## Ambiente e isolamento

Windows, Python 3.13.7 e PostgreSQL 17.2. Foi criada uma instância PostgreSQL independente,
escutando somente em 127.0.0.1:55439, em diretório de trabalho deste chat. Nenhum banco
existente foi reutilizado. Cada teste de integração criou seu próprio schema e o removeu
ao terminar. O PostgreSQL de teste foi encerrado após a validação.

As versões Python efetivamente usadas estão em `requirements.lock`. Dependências de teste:
pytest 9.2.0 e Ruff 0.17.3. O aviso único é a depreciação de httpx no TestClient da versão
instalada de Starlette; não houve falha, nem ocultação de warnings.

## Cobertura executada

- 100 solicitações concorrentes disputando 10 vagas, para atividade gratuita e paga;
  duas instâncias lógicas do serviço, várias conexões reais, sem mutex em memória.
- Pedidos concorrentes com mesma chave; unicidade por participante; conflito de chave.
- Confirmação financeira, repetição, versão antiga e divergência de valor.
- Recusa/expiração/cancelamento financeiro liberando vaga.
- Aprovação recebida após expiração, com solicitação e confirmação de estorno.
- Corridas de pagamento versus expiração e pagamento versus cancelamento.
- FIFO, prioridade sobre recém-chegados, expiração de oferta e aceite idempotente.
- Aceite concorrente de oferta paga criando uma única cobrança.
- Rollback conjunto de inscrição, contador e outbox.
- Capacidade protegida inclusive contra UPDATE SQL direto.
- Check-in, janela de horário e elegibilidade após encerramento, sem duplicação.
- Cancelamento de atividade e compensação de pagamento posterior.
- Outbox preservada quando Kafka falha; inscrição continua confirmada.
- JWT RS256 com criptografia real: assinatura estrangeira, issuer, expiração, sub e roles.
- API ASGI real: OpenAPI, healthcheck, rejeição de X-User-Id sem JWT, dados privilegiados no
  corpo, propriedade, autorização de organizador por evento, disponibilidade e replay
  idempotente mesmo com Eventos indisponível.
- HTTP de descoberta/atividade validado com transporte simulado e verificação do Bearer.
- Consumer não confirma offset antes do commit, nem após falha de processamento.
- Quarentena persistida sem copiar payload potencialmente sensível.
- Resultados de Pagamentos: regras de aprovação/recusa, tipos informativos e inscrição desconhecida (testes offline).
- Rota interna `GET /internal/registrations/{id}`: formato 200, 404 e ausência no OpenAPI.
- Cliente confluent-kafka real: publicação da outbox, serialização, chave Kafka, leitura e
  commit no cluster mock nativo do librdkafka (broker de teste simulado).

## Limites da validação

O Docker Engine estava parado. Não foram executados build da imagem nem teste com o broker
Kafka real do Compose. O mock do librdkafka valida chamadas de protocolo do cliente, mas não
comprova configuração/ACLs/rebalance/falhas de um cluster externo.

Eventos e Pagamentos ainda não têm implementação. Não é possível afirmar integração ponta
a ponta com esses serviços: seus adaptadores foram testados contra contratos controlados,
documentados em `CONTRACTS.md`. Não foram alterados seus arquivos, nem os de Usuários,
Notificações, Gateway, Certificados, Relatórios ou Discoverer. O Compose raiz não foi editado;
o overlay de configuração está inteiramente dentro de `subscription/`.

Não foi executado o script que publica rotas no gateway. Ele fica disponível para execução
explícita após os serviços estarem de pé.
