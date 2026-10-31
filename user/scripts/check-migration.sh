#!/bin/sh
# Applies the Flyway migration to a scratch PostgreSQL database and exercises the constraints with plain psql
# (no Java, no Docker). Usage: PGHOST=... PGUSER=... PGPASSWORD=... user/scripts/check-migration.sh
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
db="users_migration_check_$$"
psql -v ON_ERROR_STOP=1 -qc "CREATE DATABASE $db" postgres
trap 'psql -qc "DROP DATABASE IF EXISTS $db" postgres >/dev/null' EXIT
psql -v ON_ERROR_STOP=1 -q -d "$db" -f "$root/src/main/resources/db/migration/V1__create_users.sql"
echo "migration V1 applied"
psql -q -d "$db" -f "$root/src/test/sql/constraints.sql" 2>&1 | sed 's/^psql:[^:]*:[0-9]*: //'
