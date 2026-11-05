-- "event_id" do inbox identificava a mensagem Kafka; passa a se chamar message_id para deixar
-- event_id livre para o evento de Eventos. A chave primária (source, message_id) acompanha a coluna.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'inbox' AND column_name = 'event_id'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'inbox' AND column_name = 'message_id'
    ) THEN
        ALTER TABLE inbox RENAME COLUMN event_id TO message_id;
    END IF;
END
$$;
