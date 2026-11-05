-- Inscrições deixou de comandar Pagamentos: sem tentativas financeiras locais.
DROP TABLE IF EXISTS payment_attempts;
-- Evento de Eventos ao qual a atividade pertence; nulo em inscrições anteriores a esta migração.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS parent_event_id uuid;
