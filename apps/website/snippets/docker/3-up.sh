# memento with PostgreSQL 18 and Redis 7; --wait returns once their health checks pass
docker compose -f docker-compose.yaml up -d --wait memento
curl localhost:3000/memento/api/health
