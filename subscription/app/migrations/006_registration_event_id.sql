-- "parent_event_id" de registrations (migração 004) era o id do evento de Eventos; passa a se chamar
-- event_id, o mesmo nome usado em activity_inventory, event_attendance_emitted, certificados e pagamentos.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'registrations' AND column_name = 'parent_event_id'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'registrations' AND column_name = 'event_id'
    ) THEN
        ALTER TABLE registrations RENAME COLUMN parent_event_id TO event_id;
    END IF;
END
$$;
