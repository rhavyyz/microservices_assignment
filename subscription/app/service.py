"""Casos de uso e transações: toda alteração de vaga trava primeiro a atividade.

O bloqueio vive no PostgreSQL, portanto protege threads, processos e réplicas.
Nenhuma chamada HTTP ou Kafka acontece dentro das transações deste módulo.
"""

import json
from datetime import timedelta
from uuid import uuid4

from psycopg.types.json import Jsonb

from .contracts import DomainError

ACTIVE = ("WAITLISTED", "OFFERED", "PENDING_PAYMENT", "CONFIRMED")
HELD = ("OFFERED", "PENDING_PAYMENT")


def serializable(value):
    """Converte UUIDs e datas para o contrato JSON."""
    return json.loads(json.dumps(value, default=str))


class SubscriptionService:
    def __init__(self, db, settings):
        self.db, self.settings = db, settings

    def active_registration(self, user_id, activity_id):
        """Inscrição viva da pessoa na atividade, sem depender de Eventos."""
        with self.db.transaction() as conn:
            row = conn.execute(
                "SELECT * FROM registrations WHERE activity_id=%s AND user_id=%s AND status = ANY(%s)",
                (activity_id, user_id, list(ACTIVE)),
            ).fetchone()
            return serializable(row) if row else None

    def availability(self, activity):
        """Leitura informativa; só a transação de criação concede a vaga de fato."""
        with self.db.transaction() as conn:
            row = conn.execute(
                "SELECT * FROM activity_inventory WHERE activity_id=%s", (activity.activity_id,)
            ).fetchone()
            capacity = row["capacity"] if row else activity.capacity
            reserved = row["reserved"] if row else 0
            confirmed = row["confirmed"] if row else 0
            return {
                "activity_id": str(activity.activity_id),
                "capacity": capacity,
                "reserved": reserved,
                "confirmed": confirmed,
                "available": capacity - reserved - confirmed,
                "registration_open": activity.registration_open
                and activity.starts_at > self.now(conn)
                and (row is None or row["lifecycle"] == "OPEN"),
            }

    @staticmethod
    def now(conn):
        # clock_timestamp é lido DEPOIS de esperar pelo lock, não no início da transação.
        return conn.execute("SELECT clock_timestamp() AS now").fetchone()["now"]

    @staticmethod
    def inventory(conn, activity_id):
        row = conn.execute(
            "SELECT * FROM activity_inventory WHERE activity_id=%s FOR UPDATE", (activity_id,)
        ).fetchone()
        if not row:
            raise DomainError(404, "ACTIVITY_NOT_FOUND")
        return row

    @staticmethod
    def registration(conn, registration_id):
        row = conn.execute("SELECT * FROM registrations WHERE id=%s", (registration_id,)).fetchone()
        if not row:
            raise DomainError(404, "REGISTRATION_NOT_FOUND")
        return row

    def locked_registration(self, conn, registration_id):
        ref = self.registration(conn, registration_id)
        inv = self.inventory(conn, ref["activity_id"])
        # Releitura obrigatória: outro processo pode ter alterado o estado antes do lock.
        return inv, self.registration(conn, registration_id)

    @staticmethod
    def owner(reg, user_id):
        if str(reg["user_id"]) != str(user_id):
            raise DomainError(404, "REGISTRATION_NOT_FOUND")

    @staticmethod
    def enqueue(conn, topic, key, payload):
        event_id = str(uuid4())
        conn.execute(
            "INSERT INTO outbox(id,topic,message_key,payload) VALUES (%s,%s,%s,%s)",
            (event_id, topic, str(key), Jsonb(serializable(payload))),
        )

    def emit(self, conn, reg, event_type, request_id=None, extra=None):
        """Evento de domínio e mensagem compatível com Notificações na mesma transação.

        request_id só existe em ações originadas por HTTP; trabalho de fundo envia null.
        extra acrescenta campos próprios do tipo (ex.: AttendanceEligible).
        """
        payload = {
            "event_id": str(uuid4()),
            "schema_version": 1,
            "type": event_type,
            "registration_id": reg["id"],
            "activity_id": reg["activity_id"],
            "user_id": reg["user_id"],
            "aggregate_version": reg["version"],
            "occurred_at": self.now(conn),
            "status": reg["status"],
            "request_id": request_id,
            **(extra or {}),
        }
        self.enqueue(conn, self.settings.domain_topic, reg["id"], payload)
        messages = {
            "RegistrationConfirmed": "Sua inscrição foi confirmada.",
            "RegistrationCancelled": "Sua inscrição foi cancelada.",
            "RegistrationExpired": "O prazo da sua reserva terminou.",
            "RegistrationRejected": "O pagamento da inscrição foi recusado.",
            "WaitlistOffered": "Uma vaga está reservada para você. Aceite dentro do prazo.",
        }
        if event_type in messages:
            self.enqueue(
                conn,
                self.settings.notifications_topic,
                reg["user_id"],
                {
                    "user_id": reg["user_id"],
                    "message": messages[event_type],
                    "payload_type": event_type,
                    "payload": {
                        "event_id": payload["event_id"],
                        "registration_id": reg["id"],
                        "expires_at": reg["expires_at"],
                    },
                },
            )

    def transition(self, conn, reg, status, expires_at=None):
        # Contadores e estado individual são indivisíveis; constraints impedem ocupação inválida.
        reserved_delta = int(status in HELD) - int(reg["status"] in HELD)
        confirmed_delta = int(status == "CONFIRMED") - int(reg["status"] == "CONFIRMED")
        conn.execute(
            "UPDATE activity_inventory SET reserved=reserved+%s, confirmed=confirmed+%s WHERE activity_id=%s",
            (reserved_delta, confirmed_delta, reg["activity_id"]),
        )
        return conn.execute(
            "UPDATE registrations SET status=%s, expires_at=%s, version=version+1, "
            "updated_at=clock_timestamp() WHERE id=%s RETURNING *",
            (status, expires_at, reg["id"]),
        ).fetchone()

    def promote(self, conn, activity_id):
        """Preenche vagas pela ordem persistida; o chamador já possui o lock da atividade."""
        inv = self.inventory(conn, activity_id)
        if inv["lifecycle"] != "OPEN":
            return
        count = inv["capacity"] - inv["reserved"] - inv["confirmed"]
        waiting = conn.execute(
            "SELECT r.* FROM registrations r JOIN waitlist_entries w "
            "ON w.registration_id=r.id WHERE r.activity_id=%s AND r.status='WAITLISTED' "
            "ORDER BY w.position LIMIT %s",
            (activity_id, count),
        ).fetchall()
        for reg in waiting:
            offered = self.transition(
                conn, reg, "OFFERED", self.now(conn) + timedelta(seconds=self.settings.offer_seconds)
            )
            self.emit(conn, offered, "WaitlistOffered")

    def expire_locked(self, conn, activity_id):
        expired = conn.execute(
            "SELECT * FROM registrations WHERE activity_id=%s "
            "AND status IN ('OFFERED','PENDING_PAYMENT') AND expires_at <= %s",
            (activity_id, self.now(conn)),
        ).fetchall()
        for reg in expired:
            updated = self.transition(conn, reg, "EXPIRED")
            self.emit(conn, updated, "RegistrationExpired")
        self.promote(conn, activity_id)

    def create(self, user_id, activity, join_waitlist=True, request_id=None):
        with self.db.transaction() as conn:
            if not activity.registration_open or activity.starts_at <= self.now(conn):
                raise DomainError(409, "REGISTRATION_CLOSED")
            conn.execute(
                "INSERT INTO activity_inventory(activity_id,event_id,capacity) VALUES (%s,%s,%s) "
                "ON CONFLICT DO NOTHING",
                (activity.activity_id, activity.event_id, activity.capacity),
            )
            inv = self.inventory(conn, activity.activity_id)
            if inv["capacity"] != activity.capacity or inv["event_id"] != activity.event_id:
                raise DomainError(409, "IMMUTABLE_CAPACITY_MISMATCH")
            if inv["lifecycle"] != "OPEN":
                raise DomainError(409, "REGISTRATION_CLOSED")
            self.expire_locked(conn, activity.activity_id)
            inv = self.inventory(conn, activity.activity_id)
            # Com o lock da atividade, uma inscrição viva é de um pedido duplicado: devolve a mesma.
            existing = conn.execute(
                "SELECT * FROM registrations WHERE activity_id=%s AND user_id=%s AND status = ANY(%s)",
                (activity.activity_id, user_id, list(ACTIVE)),
            ).fetchone()
            if existing:
                return serializable(existing)
            available = inv["reserved"] + inv["confirmed"] < inv["capacity"]
            if not available and not (join_waitlist and activity.waitlist_enabled):
                raise DomainError(409, "ACTIVITY_FULL")
            # Criar como WAITLISTED permite usar uma única função para todos os deltas.
            reg = conn.execute(
                "INSERT INTO registrations(id,activity_id,user_id,status,amount_minor,currency,parent_event_id) "
                "VALUES (%s,%s,%s,'WAITLISTED',%s,%s,%s) RETURNING *",
                (
                    uuid4(),
                    activity.activity_id,
                    user_id,
                    activity.amount_minor,
                    activity.currency,
                    activity.event_id,
                ),
            ).fetchone()
            if available:
                if reg["amount_minor"]:
                    reg = self.transition(
                        conn,
                        reg,
                        "PENDING_PAYMENT",
                        self.now(conn) + timedelta(seconds=self.settings.reservation_seconds),
                    )
                    self.emit(conn, reg, "RegistrationPendingPayment", request_id)
                else:
                    reg = self.transition(conn, reg, "CONFIRMED")
                    self.emit(conn, reg, "RegistrationConfirmed", request_id)
            else:
                position = conn.execute(
                    "UPDATE activity_inventory SET next_position=next_position+1 "
                    "WHERE activity_id=%s RETURNING next_position",
                    (activity.activity_id,),
                ).fetchone()
                conn.execute(
                    "INSERT INTO waitlist_entries VALUES (%s,%s,%s)",
                    (reg["id"], activity.activity_id, position["next_position"]),
                )
                self.emit(conn, reg, "RegistrationWaitlisted", request_id)
            return serializable(reg)

    def cancel(self, registration_id, user_id, request_id=None):
        with self.db.transaction() as conn:
            inv, reg = self.locked_registration(conn, registration_id)
            self.owner(reg, user_id)
            if inv["lifecycle"] == "ENDED":
                raise DomainError(409, "ACTIVITY_ENDED")
            if reg["status"] in ACTIVE:
                reg = self.transition(conn, reg, "CANCELLED")
                self.emit(conn, reg, "RegistrationCancelled", request_id)
                self.promote(conn, reg["activity_id"])
            return serializable(reg)

    def accept(self, registration_id, user_id, activity, request_id=None):
        with self.db.transaction() as conn:
            inv, reg = self.locked_registration(conn, registration_id)
            self.owner(reg, user_id)
            if (
                inv["lifecycle"] != "OPEN"
                or not activity.registration_open
                or activity.starts_at <= self.now(conn)
            ):
                raise DomainError(409, "REGISTRATION_CLOSED")
            self.expire_locked(conn, reg["activity_id"])
            reg = self.registration(conn, registration_id)
            # Estado terminal é retornado sem exceção para preservar o commit da expiração.
            if reg["status"] != "OFFERED":
                return serializable(reg)
            if reg["amount_minor"]:
                reg = self.transition(
                    conn,
                    reg,
                    "PENDING_PAYMENT",
                    self.now(conn) + timedelta(seconds=self.settings.reservation_seconds),
                )
                self.emit(conn, reg, "RegistrationPendingPayment", request_id)
            else:
                reg = self.transition(conn, reg, "CONFIRMED")
                self.emit(conn, reg, "RegistrationConfirmed", request_id)
            return serializable(reg)

    def payment_event(self, event):
        """Regras declarativas: Pagamentos reage aos eventos de Inscrições, aqui só se aplica o resultado."""
        rid = event.request_id
        with self.db.transaction() as conn:
            ref = conn.execute("SELECT * FROM registrations WHERE id=%s", (event.registration_id,)).fetchone()
            if not ref:
                return
            _, reg = self.locked_registration(conn, event.registration_id)
            inserted = conn.execute(
                "INSERT INTO inbox(source,event_id) VALUES ('payments',%s) "
                "ON CONFLICT DO NOTHING RETURNING event_id",
                (event.event_id,),
            ).fetchone()
            if not inserted or reg["status"] != "PENDING_PAYMENT":
                return
            if event.type == "PaymentApproved":
                # Confirmação e prazo são decididos pelo mesmo lock e relógio do banco; aprovação
                # fora da reserva ou divergente é ignorada e Pagamentos estorna por conta própria.
                if (
                    reg["expires_at"] > self.now(conn)
                    and event.amount_minor == reg["amount_minor"]
                    and event.currency == reg["currency"]
                ):
                    reg = self.transition(conn, reg, "CONFIRMED")
                    self.emit(conn, reg, "RegistrationConfirmed", rid)
            elif event.type == "PaymentDeclined":
                reg = self.transition(conn, reg, "REJECTED")
                self.emit(conn, reg, "RegistrationRejected", rid)
                self.promote(conn, reg["activity_id"])

    def expire(self):
        with self.db.transaction() as conn:
            ids = conn.execute(
                "SELECT DISTINCT activity_id FROM registrations "
                "WHERE status IN ('OFFERED','PENDING_PAYMENT') AND expires_at<=clock_timestamp() "
                "LIMIT 100"
            ).fetchall()
        for row in ids:
            with self.db.transaction() as conn:
                self.inventory(conn, row["activity_id"])
                self.expire_locked(conn, row["activity_id"])

    def get(self, registration_id, user_id=None):
        with self.db.transaction() as conn:
            reg = self.registration(conn, registration_id)
            if user_id is not None:
                self.owner(reg, user_id)
            return serializable(reg)

    def internal_registration(self, registration_id):
        """Fatos da inscrição para Pagamentos (rota interna, sem identidade de usuário)."""
        with self.db.transaction() as conn:
            reg = self.registration(conn, registration_id)
            return {
                "registration_id": reg["id"],
                "user_id": reg["user_id"],
                "status": reg["status"],
                "amount_minor": reg["amount_minor"],
                "currency": reg["currency"],
                "expires_at": reg["expires_at"],
                "parent_event_id": reg["parent_event_id"],
            }

    def list(self, *, user_id=None, activity_id=None, limit=50, offset=0):
        # Colunas escolhidas pelo código, não interpoladas a partir de entrada do cliente.
        column, value = ("user_id", user_id) if user_id else ("activity_id", activity_id)
        with self.db.transaction() as conn:
            rows = conn.execute(
                f"SELECT * FROM registrations WHERE {column}=%s "
                "ORDER BY created_at DESC,id LIMIT %s OFFSET %s",
                (value, limit, offset),
            ).fetchall()
            return serializable(rows)

    def check_in(self, registration_id, organizer_id, activity, request_id=None):
        with self.db.transaction() as conn:
            inv, reg = self.locked_registration(conn, registration_id)
            now = self.now(conn)
            if reg["status"] != "CONFIRMED" or inv["lifecycle"] != "OPEN":
                raise DomainError(409, "CHECK_IN_NOT_ALLOWED")
            if not activity.starts_at <= now < activity.ends_at:
                raise DomainError(409, "OUTSIDE_CHECK_IN_WINDOW")
            attendance = conn.execute(
                "INSERT INTO attendance(registration_id,recorded_by) VALUES (%s,%s) "
                "ON CONFLICT DO NOTHING RETURNING *",
                (registration_id, organizer_id),
            ).fetchone()
            if attendance:
                reg = conn.execute(
                    "UPDATE registrations SET version=version+1, updated_at=clock_timestamp() "
                    "WHERE id=%s RETURNING *",
                    (registration_id,),
                ).fetchone()
                self.emit(conn, reg, "AttendanceRecorded", request_id)
            else:
                attendance = conn.execute(
                    "SELECT * FROM attendance WHERE registration_id=%s", (registration_id,)
                ).fetchone()
            return serializable(attendance)

    def activity_event(self, event, activity):
        with self.db.transaction() as conn:
            conn.execute(
                "INSERT INTO activity_inventory(activity_id,event_id,capacity) VALUES (%s,%s,%s) "
                "ON CONFLICT DO NOTHING",
                (activity.activity_id, activity.event_id, activity.capacity),
            )
            inv = self.inventory(conn, activity.activity_id)
            if not conn.execute(
                "INSERT INTO inbox(source,event_id) VALUES ('events',%s) ON CONFLICT DO NOTHING "
                "RETURNING event_id",
                (event.event_id,),
            ).fetchone():
                return
            cancelled = event.type == "ActivityCancelled"
            if not cancelled and self.now(conn) < activity.ends_at:
                raise DomainError(409, "ACTIVITY_NOT_ENDED")
            if inv["lifecycle"] == "CANCELLED":
                return
            conn.execute(
                "UPDATE activity_inventory SET lifecycle=%s WHERE activity_id=%s",
                ("CANCELLED" if cancelled else "ENDED", activity.activity_id),
            )
            rows = conn.execute(
                "SELECT * FROM registrations WHERE activity_id=%s AND status=ANY(%s)",
                (activity.activity_id, list(ACTIVE)),
            ).fetchall()
            # Quem estava confirmado neste momento (antes de qualquer cancelamento) é reavaliado no fim.
            confirmed = [reg for reg in rows if reg["status"] == "CONFIRMED"]
            for reg in rows:
                if cancelled or reg["status"] != "CONFIRMED":
                    reg = self.transition(conn, reg, "CANCELLED" if cancelled else "EXPIRED")
                    self.emit(conn, reg, "RegistrationCancelled" if cancelled else "RegistrationExpired")
            self.evaluate_event_attendance(conn, confirmed, inv["event_id"])

    def evaluate_event_attendance(self, conn, triggers, parent_event_id):
        """RN06: certificado por evento com presença mínima, decidida quando a última atividade encerra.

        Roda no encerramento e também no cancelamento de uma atividade (a cancelada sai da conta).
        `triggers` são as inscrições confirmadas da atividade que acabou de encerrar/ser cancelada.

        Só conta inscrições CONFIRMED. A primeira conclusão vence: inscrição confirmada depois da
        emissão em outra atividade do mesmo evento não gera segunda emissão.
        """
        # Encerramentos simultâneos de atividades do mesmo evento precisam enxergar um ao outro;
        # o lock por evento (liberado no commit) serializa a avaliação e evita que ambos desistam.
        conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (str(parent_event_id),))
        for trigger in triggers:
            rows = conn.execute(
                "SELECT i.lifecycle, (a.registration_id IS NOT NULL) AS attended "
                "FROM registrations r JOIN activity_inventory i ON i.activity_id=r.activity_id "
                "LEFT JOIN attendance a ON a.registration_id=r.id "
                "WHERE r.user_id=%s AND r.status='CONFIRMED' AND i.event_id=%s",
                (trigger["user_id"], parent_event_id),
            ).fetchall()
            if any(row["lifecycle"] != "ENDED" for row in rows):
                continue  # será avaliado quando a última atividade confirmada da pessoa encerrar
            total = len(rows)
            if not total:
                continue  # só havia a atividade cancelada: nada a certificar
            attended = sum(row["attended"] for row in rows)
            if attended * 100 < self.settings.attendance_min_percent * total:
                continue
            if not conn.execute(
                "INSERT INTO event_attendance_emitted(user_id,event_id) VALUES (%s,%s) "
                "ON CONFLICT DO NOTHING RETURNING user_id",
                (trigger["user_id"], parent_event_id),
            ).fetchone():
                continue
            reg = conn.execute(
                "UPDATE registrations SET version=version+1, updated_at=clock_timestamp() "
                "WHERE id=%s RETURNING *",
                (trigger["id"],),
            ).fetchone()
            self.emit(
                conn,
                reg,
                "AttendanceEligible",
                extra={
                    "parent_event_id": parent_event_id,
                    "attended_activities": attended,
                    "total_activities": total,
                    "attendance_percentage": round(attended * 100 / total, 2),
                },
            )
