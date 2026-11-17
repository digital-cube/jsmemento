# .env next to docker-compose.yaml: a database password, and the release to run
# (:latest is the newest release, :main the newest commit)
cat > .env <<'ENV'
POSTGRES_PASSWORD=change-me
MEMENTO_IMAGE=ghcr.io/digital-cube/jsmemento:1.1.0
ENV
