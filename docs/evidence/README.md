# Evidências de validação

Esta pasta guarda o que prova que o sistema funciona e que pode ser reproduzido. O **plano** e os **resultados dos testes automatizados**
estão em [`docs/testing/`](../testing/). Aqui ficam as evidências de execução da pilha inteira, que só podem ser geradas com Docker e navegador.

## O que anexar (marque ao concluir)

| # | Evidência | Como gerar | Arquivo |
|---|---|---|---|
| 1 | Pilha no ar | `docker compose ps > docs/evidence/compose-ps.txt` | `compose-ps.txt` |
| 2 | Demonstração do fluxo completo | `ADMIN_PASSWORD=... scripts/demo-seed.sh \| tee docs/evidence/demo-seed.log` | `demo-seed.log` |
| 3 | Testes de Usuários | `cd user && ./mvnw verify 2>&1 \| tee ../docs/evidence/user-verify.log` | `user-verify.log` |
| 4 | Testes do frontend | `cd frontend && npm run test:run 2>&1 \| tee ../docs/evidence/frontend-tests.log` | `frontend-tests.log` |
| 5 | Testes de Eventos, Pagamentos, Relatórios | `npm test` em cada pasta, saída em `*-tests.log` | `events-tests.log`, `payments-tests.log`, `reports-tests.log` |
| 6 | Testes de Inscrições e Certificados | `python -m pytest -q` em cada pasta | `subscription-tests.log`, `certificates-tests.log` |
| 7 | Testes de Go | `go test ./...` em `gateway`, `notifications`, `service-discoverer` | `go-tests.log` |
| 8 | Logs do fluxo pago | `docker compose logs --no-color subscription payments notifications gateway > docs/evidence/fluxo-pago.log` logo depois do item 2 | `fluxo-pago.log` |
| 9 | Capturas de tela | veja abaixo | `screenshots/` |
| 10 | Cenários alternativos | tabela da seção 3 de `docs/running.md`, com o `curl` e a resposta de cada um | `cenarios-alternativos.md` |

### Capturas de tela sugeridas (`screenshots/`)

`01-catalogo.png`, `02-cadastro-organizador.png`, `03-admin-aprova.png`, `04-criar-evento.png`, `05-inscricao-pendente.png`,
`06-pagamento-simulado.png`, `07-inscricao-confirmada.png`, `08-notificacao.png`, `09-relatorio-evento.png`, `10-certificado.png`,
`11-swagger-gateway.png`.

## Cuidados antes de commitar

Os logs podem conter tokens, e-mails e senhas de demonstração. Revise com `grep -inE "bearer|password|accessToken|authorization"` e apague
o que aparecer. Não commite o `.env`.

## Registro de execução

Preencha ao anexar as evidências.

| Data | Quem | Commit | Resultado | Observações |
|---|---|---|---|---|
| | | | | |
