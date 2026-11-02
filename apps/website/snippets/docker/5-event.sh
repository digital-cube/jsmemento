export MEMENTO_API_KEY=mk_…   # what create-key printed
curl -X POST localhost:3000/memento/events -H "Authorization: Bearer $MEMENTO_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"event_type":"USER_LOGIN","instance_type":"user","instance_id":42,"actor_id":"igor"}'
curl "localhost:3000/memento/entities/user/42/events?locale=sr" \
  -H "Authorization: Bearer $MEMENTO_API_KEY"
