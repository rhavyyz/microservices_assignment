"""Casos de uso e transações: toda alteração de vaga trava primeiro a atividade.

O bloqueio vive no PostgreSQL, portanto protege threads, processos e réplicas.
Nenhuma chamada HTTP ou Kafka acontece dentro das transações deste módulo.
"""

import hashlib
import json
from datetime import timedelta
from uuid import uuid4

from psycopg.types.json import Jsonb

from .contracts import DomainError

ACTIVE = ("WAITLISTED", "OFFERED", "PENDING_PAYMENT", "CONFIRMED")
HELD = ("OFFERED", "PENDING_PAYMENT")


def serializable(value):
    """Converte UUIDs e datas para o contrato JSON, inclusive respostas idempotentes."""
    return json.loads(json.dumps(value, default=str))


class SubscriptionService:
    def __init__(self, db, settings):
        self.db, self.settings = db, settings

    @staticmethod
    def fingerprint(activity_id, join_waitlist):
        return hashlib.sha256(f"{activity_id}:{join_waitlist}".encode()).hexdigest()

    def replay(self, user_id, key, activity_id, join_waitlist):
        """Uma repetição concluída não depende de Eventos estar disponível novamente."""
        with self.db.transaction() as conn:
            cached = conn.execute(
                "SELECT * FROM idempotency_keys WHERE user_id=%s AND key=%s", (user_id, key)
            ).fetchone()
            if cached:
                if cached["fingerprint"] != self.fingerprint(activity_id, join_waitlist):
                    raise DomainError(409, "IDEMPOTENCY_CONFLICT")
                return cached["response"]
        return None

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

    def emit(self, conn, reg, event_type):
        """Evento de domínio e mensagem compatível com Notificações na mesma transação."""
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

    def payment_command(self, conn, reg, attempt, command):
        self.enqueue(
            conn,
            self.settings.payment_commands,
            reg["id"],
            {
                "event_id": str(uuid4()),
                "schema_version": 1,
                "type": command,
                "idempotency_key": f"{attempt['id']}:{command}",
                "payment_attempt_id": attempt["id"],
                "registration_id": reg["id"],
                "user_id": reg["user_id"],
                "amount_minor": reg["amount_minor"],
                "currency": reg["currency"],
                "expires_at": reg["expires_at"],
            },
        )

    def request_payment(self, conn, reg):
        attempt = conn.execute(
            "INSERT INTO payment_attempts(id,registration_id,status) VALUES (%s,%s,'REQUESTED') RETURNING *",
            (uuid4(), reg["id"]),
        ).fetchone()
        self.payment_command(conn, reg, attempt, "PaymentRequested")

    def compensate(self, conn, reg):
        attempt = conn.execute(
            "SELECT * FROM payment_attempts WHERE registration_id=%s", (reg["id"],)
        ).fetchone()
        if not attempt or attempt["status"] in ("DECLINED", "EXPIRED", "CANCELLED", "REFUNDED"):
            return
        approved = attempt["status"] in ("APPROVED", "REFUND_PENDING")
        conn.execute(
            "UPDATE payment_attempts SET status=%s WHERE id=%s",
            ("REFUND_PENDING" if approved else "CANCEL_PENDING", attempt["id"]),
        )
        self.payment_command(
            conn, reg, attempt, "PaymentRefundRequested" if approved else "PaymentCancelRequested"
        )

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
            self.compensate(conn, updated)
            self.emit(conn, updated, "RegistrationExpired")
        self.promote(conn, activity_id)

    def create(self, user_id, key, activity, join_waitlist=True):
        if not key or len(key) > 128:
            raise DomainError(400, "INVALID_IDEMPOTENCY_KEY")
        fingerprint = self.fingerprint(activity.activity_id, join_waitlist)
        with self.db.transaction() as conn:
            # Serializa a chave mesmo quando duas chamadas usam atividades diferentes.
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s,0))", (f"{user_id}:{key}",))
            cached = conn.execute(
                "SELECT * FROM idempotency_keys WHERE user_id=%s AND key=%s", (user_id, key)
            ).fetchone()
            if cached:
                if cached["fingerprint"] != fingerprint:
                    raise DomainError(409, "IDEMPOTENCY_CONFLICT")
                return cached["response"]
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
            if conn.execute(
                "SELECT 1 FROM registrations WHERE activity_id=%s AND user_id=%s AND status = ANY(%s)",
                (activity.activity_id, user_id, list(ACTIVE)),
            ).fetchone():
                raise DomainError(409, "ALREADY_REGISTERED")
            available = inv["reserved"] + inv["confirmed"] < inv["capacity"]
            if not available and not (join_waitlist and activity.waitlist_enabled):
                raise DomainError(409, "ACTIVITY_FULL")
            # Criar como WAITLISTED permite usar uma única função para todos os deltas.
            reg = conn.execute(
                "INSERT INTO registrations(id,activity_id,user_id,status,amount_minor,currency) "
                "VALUES (%s,%s,%s,'WAITLISTED',%s,%s) RETURNING *",
                (uuid4(), activity.activity_id, user_id, activity.amount_minor, activity.currency),
            ).fetchone()
            if available:
                if reg["amount_minor"]:
                    reg = self.transition(
                        conn,
                        reg,
                        "PENDING_PAYMENT",
                        self.now(conn) + timedelta(seconds=self.settings.reservation_seconds),
                    )
                    self.request_payment(conn, reg)
                else:
                    reg = self.transition(conn, reg, "CONFIRMED")
                    self.emit(conn, reg, "RegistrationConfirmed")
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
                self.emit(conn, reg, "RegistrationWaitlisted")
            response = serializable(reg)
            conn.execute(
                "INSERT INTO idempotency_keys VALUES (%s,%s,%s,%s)",
                (user_id, key, fingerprint, Jsonb(response)),
            )
            return response

    def cancel(self, registration_id, user_id):
        with self.db.transaction() as conn:
            inv, reg = self.locked_registration(conn, registration_id)
            self.owner(reg, user_id)
            if inv["lifecycle"] == "ENDED":
                raise DomainError(409, "ACTIVITY_ENDED")
            if reg["status"] in ACTIVE:
                reg = self.transition(conn, reg, "CANCELLED")
                self.compensate(conn, reg)
                self.emit(conn, reg, "RegistrationCancelled")
                self.promote(conn, reg["activity_id"])
            return serializable(reg)

    def accept(self, registration_id, user_id, activity):
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
                self.request_payment(conn, reg)
            else:
                reg = self.transition(conn, reg, "CONFIRMED")
                self.emit(conn, reg, "RegistrationConfirmed")
            return serializable(reg)

    def payment_event(self, event):
        with self.db.transaction() as conn:
            inv, reg = self.locked_registration(conn, event.registration_id)
            inserted = conn.execute(
                "INSERT INTO inbox(source,event_id) VALUES ('payments',%s) "
                "ON CONFLICT DO NOTHING RETURNING event_id",
                (event.event_id,),
            ).fetchone()
            if not inserted:
                return
            attempt = conn.execute(
                "SELECT * FROM payment_attempts WHERE id=%s AND registration_id=%s",
                (event.payment_attempt_id, reg["id"]),
            ).fetchone()
            if not attempt or event.amount_minor != reg["amount_minor"] or event.currency != reg["currency"]:
                raise DomainError(409, "PAYMENT_CONTRACT_MISMATCH")
            if event.provider_version <= attempt["provider_version"]:
                return
            # Efetivação e expiração são decididas pelo mesmo lock e relógio do banco.
            self.expire_locked(conn, reg["activity_id"])
            reg = self.registration(conn, reg["id"])
            states = {
                "PaymentApproved": "APPROVED",
                "PaymentDeclined": "DECLINED",
                "PaymentExpired": "EXPIRED",
                "PaymentCancelled": "CANCELLED",
                "PaymentRefunded": "REFUNDED",
            }
            financial = states[event.type]
            # Snapshots terminais não podem regredir para aprovação; isso é erro do produtor.
            if attempt["status"] == "REFUNDED" and financial != "REFUNDED":
                raise DomainError(409, "INVALID_PAYMENT_TRANSITION")
            conn.execute(
                "UPDATE payment_attempts SET status=%s,provider_version=%s,checked_at=clock_timestamp() "
                "WHERE id=%s",
                (financial, event.provider_version, attempt["id"]),
            )
            if financial == "APPROVED":
                if reg["status"] == "PENDING_PAYMENT" and inv["lifecycle"] == "OPEN":
                    reg = self.transition(conn, reg, "CONFIRMED")
                    self.emit(conn, reg, "RegistrationConfirmed")
                elif reg["status"] != "CONFIRMED":
                    self.compensate(conn, reg)
            elif reg["status"] == "PENDING_PAYMENT":
                target = "REJECTED" if financial == "DECLINED" else "EXPIRED"
                reg = self.transition(conn, reg, target)
                self.emit(
                    conn, reg, "RegistrationRejected" if target == "REJECTED" else "RegistrationExpired"
                )
            elif reg["status"] == "CONFIRMED":
                # Uma reversão financeira válida também revoga a inscrição, sem confirmar de novo.
                reg = self.transition(conn, reg, "CANCELLED")
                self.emit(conn, reg, "RegistrationCancelled")
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
            payment = conn.execute(
                "SELECT id,status FROM payment_attempts WHERE registration_id=%s", (registration_id,)
            ).fetchone()
            reg["payment"] = payment
            return serializable(reg)

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

    def check_in(self, registration_id, organizer_id, activity):
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
                self.emit(conn, reg, "AttendanceRecorded")
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
            for reg in rows:
                if cancelled or reg["status"] != "CONFIRMED":
                    reg = self.transition(conn, reg, "CANCELLED" if cancelled else "EXPIRED")
                    self.compensate(conn, reg)
                    self.emit(conn, reg, "RegistrationCancelled" if cancelled else "RegistrationExpired")
                else:
                    # Critério inicial de presença: ao menos um check-in válido. Certificados emite o documento.
                    present = conn.execute(
                        "UPDATE attendance SET eligible_emitted=true WHERE registration_id=%s "
                        "AND NOT eligible_emitted RETURNING registration_id",
                        (reg["id"],),
                    ).fetchone()
                    if present:
                        reg = conn.execute(
                            "UPDATE registrations SET version=version+1, updated_at=clock_timestamp() "
                            "WHERE id=%s RETURNING *",
                            (reg["id"],),
                        ).fetchone()
                        self.emit(conn, reg, "AttendanceEligible")

    def reconciliation_candidates(self):
        with self.db.transaction() as conn:
            return conn.execute(
                "SELECT id FROM payment_attempts WHERE status IN "
                "('REQUESTED','CANCEL_PENDING','REFUND_PENDING') AND "
                "checked_at < clock_timestamp() - (%s * interval '1 second') LIMIT 50",
                (self.settings.reconcile_seconds,),
            ).fetchall()

    def reconcile(self, attempt_id, event):
        if str(event.payment_attempt_id) != str(attempt_id):
            raise DomainError(409, "PAYMENT_CONTRACT_MISMATCH")
        self.payment_event(event)
        with self.db.transaction() as conn:
            ref = conn.execute(
                "SELECT registration_id FROM payment_attempts WHERE id=%s", (attempt_id,)
            ).fetchone()
            _, reg = self.locked_registration(conn, ref["registration_id"])
            conn.execute(
                "UPDATE payment_attempts SET checked_at=clock_timestamp() WHERE id=%s", (attempt_id,)
            )
            if reg["status"] not in ACTIVE:
                self.compensate(conn, reg)
