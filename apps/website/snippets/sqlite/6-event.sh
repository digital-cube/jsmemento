export KEY=mk_…   # what create-key printed
curl -s localhost:9300/memento/api/health; echo
curl -s -X POST localhost:9300/memento/events -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"event_type":"USER_LOGIN","instance_type":"user","instance_id":42,"actor_id":"igor"}' \
  | jq '.data | {event_type, instance_type, instance_id, rendered}'
curl -s "localhost:9300/memento/entities/user/42/events?locale=sr" -H "Authorization: Bearer $KEY" \
  | jq -c '[.data[] | {event_type, actor_id, rendered}]'
ls data
