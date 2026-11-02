# a tenant, and an API key of it with both scopes: the mk_… secret is printed this once
docker compose -f docker-compose.yaml exec memento memento create-tenant acme --name "Acme Inc"
docker compose -f docker-compose.yaml exec memento \
  memento create-key --tenant acme --scopes read,write --name backend
