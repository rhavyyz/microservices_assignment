#!/usr/bin/env bash
# Popula o sistema com dados de demonstração pelo Gateway e percorre o fluxo completo de inscrição paga.
# Requisitos: curl, python3 e a pilha no ar (veja docs/running.md), com o administrador de bootstrap ativo.
# Uso:  ADMIN_EMAIL=admin@example.test ADMIN_PASSWORD='...' scripts/demo-seed.sh
# Idempotente na parte de usuários (cadastro repetido é ignorado). Cada execução cria um evento novo.
set -euo pipefail

GATEWAY="${GATEWAY:-http://localhost:8080}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:?defina ADMIN_PASSWORD (USERS_ADMIN_BOOTSTRAP_PASSWORD do .env)}"
DEMO_PASSWORD="${DEMO_PASSWORD:-Demo#Senha2026}"
ORG_EMAIL="${ORG_EMAIL:-organizador.demo@example.test}"
PART_EMAIL="${PART_EMAIL:-participante.demo@example.test}"
YEAR="${DEMO_YEAR:-2027}"   # as atividades precisam começar no futuro

step() { printf '\n==> %s\n' "$*"; }
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

# api METHOD PATH [TOKEN] [BODY]  -> imprime o corpo, falha com o status se não for 2xx
api() {
  local method=$1 path=$2 token=${3:-} body=${4:-} out status
  local args=(-sS -X "$method" -w '\n%{http_code}' "$GATEWAY/$path")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  out=$(curl "${args[@]}")
  status=${out##*$'\n'}; out=${out%$'\n'*}
  case $status in 2??) printf '%s' "$out" ;; *) printf 'ERRO %s %s -> HTTP %s: %s\n' "$method" "$path" "$status" "$out" >&2; return 1 ;; esac
}
login() { api POST user/api/v1/auth/login "" "{\"email\":\"$1\",\"password\":\"$2\"}" | json "d['accessToken']"; }
register() { # ignora "e-mail já cadastrado" (409)
  local s
  s=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$GATEWAY/user/api/v1/auth/register" -H 'Content-Type: application/json' -d "$1")
  case $s in 201) echo "  criado";; 409) echo "  já existia";; *) echo "  falhou (HTTP $s)" >&2; return 1;; esac
}

step "Usuários: participante e candidato a organizador"
register "{\"name\":\"Participante Demo\",\"email\":\"$PART_EMAIL\",\"password\":\"$DEMO_PASSWORD\"}"
register "{\"name\":\"Organizador Demo\",\"email\":\"$ORG_EMAIL\",\"password\":\"$DEMO_PASSWORD\",\"requestedRole\":\"ORGANIZER\"}"

step "Administrador aprova o pedido de organizador"
ADMIN_TOKEN=$(login "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
ORG_ID=$(api GET "user/api/v1/admin/users?q=$ORG_EMAIL&size=10" "$ADMIN_TOKEN" |
  json "[u['id'] for u in d['items'] if u['email']=='$ORG_EMAIL'][0]")
api PUT "user/api/v1/admin/users/$ORG_ID/organizer" "$ADMIN_TOKEN" '{"approved":true}' >/dev/null
echo "  organizador $ORG_ID"

step "Organizador cria e publica um evento com uma atividade paga e uma gratuita"
ORG_TOKEN=$(login "$ORG_EMAIL" "$DEMO_PASSWORD")   # novo login: o papel viaja no token
EVENT_ID=$(api POST events/api/v1/events "$ORG_TOKEN" \
  "{\"title\":\"Semana de Computação $(date +%H%M%S)\",\"organization\":\"EventHub\",\"location\":\"Fortaleza\",\"starts_at\":\"$YEAR-03-10T09:00:00.000Z\",\"ends_at\":\"$YEAR-03-12T18:00:00.000Z\"}" |
  json "d['event_id']")
PAID_ID=$(api POST "events/api/v1/events/$EVENT_ID/activities" "$ORG_TOKEN" \
  "{\"title\":\"Workshop de Kafka (pago)\",\"speaker\":\"Equipe EventHub\",\"starts_at\":\"$YEAR-03-10T14:00:00.000Z\",\"ends_at\":\"$YEAR-03-10T17:00:00.000Z\",\"capacity\":2,\"amount_minor\":5000,\"waitlist_enabled\":true}" |
  json "d['activity_id']")
FREE_ID=$(api POST "events/api/v1/events/$EVENT_ID/activities" "$ORG_TOKEN" \
  "{\"title\":\"Palestra de abertura (gratuita)\",\"starts_at\":\"$YEAR-03-10T09:00:00.000Z\",\"ends_at\":\"$YEAR-03-10T10:00:00.000Z\",\"capacity\":100,\"amount_minor\":0,\"waitlist_enabled\":false}" |
  json "d['activity_id']")
api POST "events/api/v1/events/$EVENT_ID/publish" "$ORG_TOKEN" >/dev/null
echo "  evento $EVENT_ID | atividade paga $PAID_ID | gratuita $FREE_ID"

step "Participante: inscrição paga (aprovada)"
PART_TOKEN=$(login "$PART_EMAIL" "$DEMO_PASSWORD")
REG=$(api POST "subscription/api/v1/activities/$PAID_ID/registrations" "$PART_TOKEN" '{"join_waitlist":false}')
REG_ID=$(printf '%s' "$REG" | json "d['registration_id'] if 'registration_id' in d else d['id']")
echo "  inscrição $REG_ID: $(printf '%s' "$REG" | json "d['status']")"
PAY=$(api POST payments/payments "$PART_TOKEN" "{\"registration_id\":\"$REG_ID\"}")
PAY_ID=$(printf '%s' "$PAY" | json "d['payment_id'] if 'payment_id' in d else d['id']")
api POST "payments/payments/$PAY_ID/simulate" "$PART_TOKEN" '{"action":"approve"}' >/dev/null
echo "  pagamento $PAY_ID aprovado; aguardando a confirmação assíncrona..."
for _ in $(seq 1 20); do
  STATUS=$(api GET "subscription/api/v1/registrations/$REG_ID" "$PART_TOKEN" | json "d['status']")
  [ "$STATUS" = CONFIRMED ] && break; sleep 1
done
echo "  estado final da inscrição: $STATUS"
[ "$STATUS" = CONFIRMED ] || { echo "A inscrição não foi confirmada em 20 s: veja docs/evidence/README.md (diagnóstico)." >&2; exit 1; }

step "Pronto"
cat <<OUT
Contas (senha: \$DEMO_PASSWORD): $PART_EMAIL (participante), $ORG_EMAIL (organizador), $ADMIN_EMAIL (administrador)
Evento $EVENT_ID. Para ver a recusa e a expiração, inscreva outra conta na atividade $PAID_ID
e use 'decline' ou 'expire' em POST payments/payments/{id}/simulate.
OUT
