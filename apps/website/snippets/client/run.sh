curl -O https://service.stage.memento-service.org/clients/javascript.zip
unzip javascript.zip && cd javascript
export MEMENTO_API_KEY=mk_…   # read + write; MEMENTO_URL defaults to the same service
node memento.mjs
