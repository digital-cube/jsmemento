# Until the first release puts @jsmemento/* on npm: build and pack them from a clone
git clone https://github.com/digital-cube/jsmemento.git && cd jsmemento
pnpm install && pnpm turbo run build --filter="./packages/*"
pnpm --filter "./packages/*" pack --pack-destination ../memento-tarballs
cd ..

# your app: Fastify, the server plugin, the protocol client and the CLI
mkdir my-app && cd my-app && npm init -y && npm pkg set type=module
npm install fastify ../memento-tarballs/memento-{core,lookups,server,cli}-1.0.0.tgz
