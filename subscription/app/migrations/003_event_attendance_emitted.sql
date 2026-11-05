-- RN06: o certificado é por EVENTO. Uma linha aqui garante no máximo um AttendanceEligible por
-- (pessoa, evento); "event_id" é o id do evento no serviço de Eventos (activity_inventory.event_id).
-- Sem backfill: inscrições confirmadas com check-in cujas atividades encerraram ANTES desta
-- migração não são reavaliadas.
-- attendance.eligible_emitted (migração 001) foi SUPERADA por esta tabela e não é mais usada;
-- a coluna permanece apenas por compatibilidade (sem alteração destrutiva).
CREATE TABLE event_attendance_emitted (
    user_id uuid NOT NULL,
    event_id uuid NOT NULL,
    emitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (user_id, event_id)
);
