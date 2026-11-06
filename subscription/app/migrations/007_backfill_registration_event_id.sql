-- Inscrições criadas antes da migração 004 não guardaram o evento de Eventos. Preenche registrations.event_id
-- a partir de activity_inventory.event_id (NOT NULL). Só toca linhas nulas; a coluna continua anulável.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'registrations' AND column_name = 'event_id'
    ) THEN
        UPDATE registrations r
        SET event_id = a.event_id
        FROM activity_inventory a
        WHERE a.activity_id = r.activity_id AND r.event_id IS NULL;
    END IF;
END
$$;
