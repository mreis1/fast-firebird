#!/usr/bin/env bash
# Safe cleanup: removes ONLY resources owned by the fast-firebird-test compose
# project. Never runs prune. Never touches anything not named fast-firebird-test-*.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker/docker-compose.yml"
PROJECT=fast-firebird-test

echo "Removing compose project '$PROJECT' (containers, project network, project volumes)..."
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down -v --remove-orphans

# Post-condition check: nothing of ours should remain
leftovers=$( (docker ps -a --format '{{.Names}}'; docker volume ls --format '{{.Name}}'; docker network ls --format '{{.Name}}') | grep '^fast-firebird-test' || true)
if [[ -n "$leftovers" ]]; then
  echo "WARNING: leftover project resources:" >&2
  echo "$leftovers" >&2
  exit 1
fi
echo "Done. Only fast-firebird-test-* resources were removed. Images are left cached."
