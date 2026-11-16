export DATABASE_URL=file:data/app.db    # SQLite: one file, no database service
# export DATABASE_URL=postgresql://jsmemento:change-me@localhost:5432/app    # or PostgreSQL
node server.ts                      # migrates, then listens on :8000

# another terminal: a tenant and a key, straight into the same database
export DATABASE_URL=file:data/app.db
npx memento create-tenant acme --name "Acme Inc"
npx memento create-key --tenant acme --scopes read,write --name app
MEMENTO_API_KEY=mk_… node tail.ts   # [live], then one line per event of user/42

# a third: push one
curl -X POST localhost:8000/memento/events -H "Authorization: Bearer mk_…" \
  -H 'content-type: application/json' \
  -d '{"event_type":"USER_LOGIN","instance_type":"user","instance_id":42,"actor_id":"igor"}'
