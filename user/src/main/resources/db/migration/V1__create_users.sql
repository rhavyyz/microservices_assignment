-- Serviço de Usuários: dono exclusivo destes dados (Database per Service).

CREATE TABLE users (
    id            UUID         NOT NULL,
    name          VARCHAR(120) NOT NULL,
    email         VARCHAR(254) NOT NULL,
    password_hash VARCHAR(100) NOT NULL,
    status        VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
    created_at    TIMESTAMPTZ  NOT NULL,
    updated_at    TIMESTAMPTZ  NOT NULL,
    CONSTRAINT pk_users PRIMARY KEY (id),
    -- Proteção contra cadastros concorrentes com o mesmo e-mail (a checagem em Java não basta).
    CONSTRAINT uk_users_email UNIQUE (email),
    -- O e-mail é gravado normalizado (trim + minúsculas); o banco recusa qualquer outra forma.
    CONSTRAINT ck_users_email_normalized CHECK (email = lower(btrim(email))),
    CONSTRAINT ck_users_status CHECK (status IN ('ACTIVE', 'INACTIVE')),
    CONSTRAINT ck_users_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE TABLE user_roles (
    user_id UUID        NOT NULL,
    role    VARCHAR(20) NOT NULL,
    CONSTRAINT pk_user_roles PRIMARY KEY (user_id, role),
    CONSTRAINT fk_user_roles_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT ck_user_roles_role CHECK (role IN ('PARTICIPANT', 'ORGANIZER'))
);
