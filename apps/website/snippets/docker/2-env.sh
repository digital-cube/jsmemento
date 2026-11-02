# .env next to docker-compose.yaml: a database password, and the image of the main branch
# (the :latest tag arrives with the first release)
cat > .env <<'ENV'
POSTGRES_PASSWORD=change-me
MEMENTO_IMAGE=ghcr.io/digital-cube/jsmemento:main
ENV
