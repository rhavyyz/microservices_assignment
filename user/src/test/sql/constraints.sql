\set ON_ERROR_STOP off
\echo '--- 1 insert valido (esperado OK)'
INSERT INTO users(id,name,email,password_hash,status,created_at,updated_at) VALUES ('7b1a9b7d-045e-4d58-85b3-345a6f78a101','Mariana','mariana@example.com','$2a$10$x','ACTIVE',now(),now());
\echo '--- 2 email duplicado (esperado: uk_users_email)'
INSERT INTO users(id,name,email,password_hash,status,created_at,updated_at) VALUES ('7b1a9b7d-045e-4d58-85b3-345a6f78a102','Outra','mariana@example.com','$2a$10$x','ACTIVE',now(),now());
\echo '--- 3 email com maiusculas (esperado: ck_users_email_normalized)'
INSERT INTO users(id,name,email,password_hash,status,created_at,updated_at) VALUES ('7b1a9b7d-045e-4d58-85b3-345a6f78a103','X','Joao@Example.com','$2a$10$x','ACTIVE',now(),now());
\echo '--- 4 email com espaco (esperado: ck_users_email_normalized)'
INSERT INTO users(id,name,email,password_hash,status,created_at,updated_at) VALUES ('7b1a9b7d-045e-4d58-85b3-345a6f78a104','X',' joao@example.com','$2a$10$x','ACTIVE',now(),now());
\echo '--- 5 status invalido (esperado: ck_users_status)'
INSERT INTO users(id,name,email,password_hash,status,created_at,updated_at) VALUES ('7b1a9b7d-045e-4d58-85b3-345a6f78a105','X','a@example.com','$2a$10$x','ADMIN',now(),now());
\echo '--- 6 nome em branco (esperado: ck_users_name_not_blank)'
INSERT INTO users(id,name,email,password_hash,status,created_at,updated_at) VALUES ('7b1a9b7d-045e-4d58-85b3-345a6f78a106','   ','b@example.com','$2a$10$x','ACTIVE',now(),now());
\echo '--- 7 papel valido (esperado OK)'
INSERT INTO user_roles VALUES ('7b1a9b7d-045e-4d58-85b3-345a6f78a101','PARTICIPANT');
\echo '--- 8 papel invalido ADMIN (esperado: ck_user_roles_role)'
INSERT INTO user_roles VALUES ('7b1a9b7d-045e-4d58-85b3-345a6f78a101','ADMIN');
\echo '--- 9 papel repetido (esperado: pk_user_roles)'
INSERT INTO user_roles VALUES ('7b1a9b7d-045e-4d58-85b3-345a6f78a101','PARTICIPANT');
\echo '--- 10 papel de usuario inexistente (esperado: fk_user_roles_user)'
INSERT INTO user_roles VALUES ('00000000-0000-0000-0000-000000000000','PARTICIPANT');
\echo '--- 11 delete em cascata (esperado: 0 papeis restantes)'
DELETE FROM users WHERE id='7b1a9b7d-045e-4d58-85b3-345a6f78a101';
SELECT count(*) AS roles_restantes FROM user_roles;
