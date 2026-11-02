docker compose -f docker-compose.yaml down        # stop; the data stays in named volumes
docker compose -f docker-compose.yaml down -v     # stop and delete the data too
