#!/bin/bash
set -euo pipefail
provider=/run/harbor-secrets/read-secret
test -x "$provider" || { echo 'Missing external secret provider' >&2; exit 1; }
export MYSQL_ROOT_PASSWORD MYSQL_PASSWORD
MYSQL_ROOT_PASSWORD="$("$provider" MYSQL_ROOT_PASSWORD 2>/dev/null)"
MYSQL_PASSWORD="$("$provider" MYSQL_APP_PASSWORD 2>/dev/null)"
test -n "$MYSQL_ROOT_PASSWORD" && test -n "$MYSQL_PASSWORD"
exec /usr/local/bin/docker-entrypoint.sh "$@"
