# @memento/server

The JSMemento server: a Fastify plugin (`mementoPlugin`) and app factory (`buildApp`) with Drizzle/PostgreSQL storage, API-key auth, Handlebars rendering, chats and the `/ws` real-time stream. `node dist/server.js` runs it standalone; the Docker image is `ghcr.io/digital-cube/jsmemento`.

Part of [JSMemento](https://github.com/digital-cube/jsmemento), a self-hosted, tenant-isolated
activity ledger. Docs: [API](https://github.com/digital-cube/jsmemento/blob/main/docs/API.md), [ARCHITECTURE](https://github.com/digital-cube/jsmemento/blob/main/docs/ARCHITECTURE.md), [DEPLOYMENT](https://github.com/digital-cube/jsmemento/blob/main/docs/DEPLOYMENT.md).

Requires Node 24+. MIT licensed.
