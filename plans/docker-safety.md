# Docker Safety Rules (MANDATORY)

The host machine has pre-existing Docker containers, images, volumes, and networks
that MUST NOT be touched. Snapshot taken 2026-07-08: 45 containers, 48 images,
44 volumes, 15 networks (stored in session scratchpad for verification).

## Naming convention — everything is prefixed

| Resource        | Name                                        |
|-----------------|---------------------------------------------|
| Compose project | `fast-firebird-test`                        |
| Containers      | `fast-firebird-test-fb3` / `-fb4` / `-fb5`  |
| Network         | `fast-firebird-test-net`                    |
| Volumes         | `fast-firebird-test-fb3-data`, etc.         |
| Host ports      | 30503 (FB3), 30504 (FB4), 30505 (FB5) — non-default to avoid clashing with any local 3050 |

## Allowed commands

- `docker compose -p fast-firebird-test -f docker/docker-compose.yml up -d --wait`
- `docker compose -p fast-firebird-test -f docker/docker-compose.yml down -v`
  (the `-v` here removes ONLY volumes declared by this compose project)
- `docker logs fast-firebird-test-fb5`, `docker exec fast-firebird-test-fb5 ...`
- Read-only listing commands (`docker ps`, `docker images`, `docker volume ls`)

## Forbidden — never run

- `docker system prune`, `docker container prune`, `docker volume prune`,
  `docker network prune`, `docker image prune`
- `docker rm` / `docker rmi` / `docker volume rm` / `docker network rm` on anything
  not named `fast-firebird-test-*`
- Any command that stops/restarts/removes containers not owned by this project
- Binding host port 3050 (may be in use by a local Firebird)

## Cleanup

Only via `scripts/docker-cleanup.sh`, which:
1. Runs `docker compose -p fast-firebird-test -f docker/docker-compose.yml down -v --remove-orphans`
2. Verifies afterwards that it removed only `fast-firebird-test-*` resources
3. Never touches images (the `firebirdsql/firebird` / `jacobalberty/firebird` images
   stay cached; harmless and re-usable)

Test databases live only inside project-owned volumes or `docker/data/` (gitignored).
