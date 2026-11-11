# ADR-001 — Estratégia de decomposição dos serviços

- **Status:** Aprovada
- **Detalhes de implementação:** [technical-decisions.md](../architecture/technical-decisions.md) (DT-01 a DT-11)

## Contexto
O sistema tem 11 requisitos funcionais, forças e regras de negócio que precisam ser considerados para estruturar os microsserviços.

## Alternativas consideradas
1. Serviço por funcionalidade.
2. Serviço por capacidade de negócio.
3. Divisão horizontal (cada mudança de negócio atravessaria todos os serviços).

## Decisão
Decompor por **capacidade de negócio**, agrupando o que tem forte coesão e separando o que compartilha pouca lógica.

## Evidências
1. Requisitos: RQ01 (evolução independente), RQ02 (escalabilidade seletiva), RQ03 (disponibilidade e resiliência) e RQ05 (interoperabilidade).
2. Regras de negócio: RN01 (reserva de vaga), RN02 (pagamento e confirmação), RN03 (pagamento recusado), RN05 (notificações desacopladas), RN06 (certificados) e RN07 (segurança e acesso).
3. Restrições: equipe pequena e prazo acadêmico, então um grande número de serviços não é sustentável.
4. Implementação: o monorepo tem uma pasta por serviço. Relatórios e Pagamentos já existem com banco e contrato próprios.

## Justificativa
Um serviço por funcionalidade geraria serviços sem sentido isolados e custo insustentável. Serviços muito abrangentes quebrariam RQ01, RQ02 e RQ03. A divisão isola o que precisa evoluir, escalar ou falhar sozinho e mantém juntas as funcionalidades dependentes.

| Serviço | Justificativa |
|---|---|
| **Eventos** | Reúne eventos, programação, consulta, busca e a capacidade das atividades, porque nenhuma delas faz sentido sem o evento. |
| **Inscrição** | Reúne inscrição, lista de espera e check-in, que dependem do ciclo de vida da inscrição. Protege a vaga contra excesso de reservas (RN01). |
| **Pagamentos** | Isolado porque usa um provedor externo (simulado), com falha, recusa e expiração próprias. A instabilidade do pagamento não contamina as inscrições (RN02, RN03). |
| **Usuário e Perfis** | Concentra usuários, perfis, autenticação e autorização. Todos usam a identidade, mas ele não depende de nenhum deles (RN07). |
| **Notificações** | Evolui sozinho (RQ01) e pode falhar sem desfazer uma inscrição confirmada (RN05, RQ03). |
| **Certificados** | Carga quase nula, então não divide escala com as inscrições (RQ02). Só emite depois do evento, para quem cumpriu a presença (RN06). |
| **Relatórios** | Só lê dados, montados a partir dos eventos dos outros serviços. Fica fora do caminho crítico (RQ03). |
| **Gateway e service-discoverer** | Infraestrutura. O Gateway é a entrada única do front e centraliza roteamento e identidade. O discoverer permite que os serviços se encontrem sem endereço fixo. |

## Consequências
**Positivas:** escala e falha isoladas, coesão preservada, regras de negócio com dono claro e quantidade de serviços sustentável para uma equipe pequena.

**Negativas:** pontos únicos de falha (Gateway e service-discoverer), dependência constante do serviço de Usuário e Perfis para autenticação e alguns serviços ainda grandes, que podem precisar ser divididos.
