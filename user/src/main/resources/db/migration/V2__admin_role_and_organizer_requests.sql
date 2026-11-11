-- Papel ADMIN e pedido de organizador (ADR-009).
-- O cadastro público continua criando só PARTICIPANT; quem escolhe "organizador" fica com um pedido PENDING até
-- um ADMIN decidir. O papel ORGANIZER só entra em user_roles por decisão de um ADMIN.

ALTER TABLE user_roles DROP CONSTRAINT ck_user_roles_role;
ALTER TABLE user_roles
    ADD CONSTRAINT ck_user_roles_role CHECK (role IN ('PARTICIPANT', 'ORGANIZER', 'ADMIN'));

ALTER TABLE users
    ADD COLUMN organizer_request            VARCHAR(20) NOT NULL DEFAULT 'NONE',
    ADD COLUMN organizer_request_updated_at TIMESTAMPTZ NULL,
    ADD CONSTRAINT ck_users_organizer_request CHECK (organizer_request IN ('NONE', 'PENDING', 'APPROVED', 'DENIED'));

-- Quem já era organizador antes desta migração não tem pedido a decidir.
UPDATE users SET organizer_request = 'APPROVED'
 WHERE id IN (SELECT user_id FROM user_roles WHERE role = 'ORGANIZER');
