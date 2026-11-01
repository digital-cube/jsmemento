import { ok } from "@memento/core";
import type { FastifyPluginAsync } from "fastify";
import type { RouteDeps } from "../app.js";
import { acceptEmptyJson } from "../auth.js";
import type { LimitsConfig } from "../config.js";
import type { QuotaGuard } from "../quota.js";
import { KeyService } from "../services/keys.js";

export interface KeyRoutesOptions extends RouteDeps {
  quota: QuotaGuard;
  limits: LimitsConfig;
}

type KeyParams = { Params: { id: string } };
const SESSION = { auth: "session" } as const;

/**
 * The signed-in user's API keys (`MEMENTO_ACCOUNTS`, session cookie only — an API key is
 * refused): create, rename / change the daily limit, pause, resume, delete. Listing is the
 * `api_keys` UDC collection. A key of another tenant answers 404.
 */
export const keyRoutes: FastifyPluginAsync<KeyRoutesOptions> = async (app, options) => {
  acceptEmptyJson(app);
  const { db, quota, limits, publisher, renderer, lookups } = options;
  const keys = new KeyService({
    db,
    quota,
    limits,
    push: {
      publisher,
      renderer,
      lookups,
      onPublishError: (error) =>
        app.log.warn({ err: error }, "lifecycle event stored but publishing failed"),
    },
  });

  /** `{name, scopes, expires_at?, daily_limit?}` → 201 `{api_key, key}`: the key, this once. */
  app.post("/keys", { config: SESSION }, async (request, reply) => {
    const { apiKey, key } = await keys.create(request.body);
    // Never the plaintext: only the key's id and prefix reach the log.
    request.log.info({ api_key: apiKey.id, prefix: apiKey.prefix }, "API key created");
    return reply.status(201).send(ok({ api_key: apiKey, key }));
  });

  app.patch<KeyParams>("/keys/:id", { config: SESSION }, async (request) =>
    ok({ api_key: await keys.update(request.params.id, request.body) }),
  );

  app.post<KeyParams>("/keys/:id/disable", { config: SESSION }, async (request) =>
    ok({ api_key: await keys.setDisabled(request.params.id, true) }),
  );

  app.post<KeyParams>("/keys/:id/enable", { config: SESSION }, async (request) =>
    ok({ api_key: await keys.setDisabled(request.params.id, false) }),
  );

  app.delete<KeyParams>("/keys/:id", { config: SESSION }, async (request, reply) => {
    await keys.delete(request.params.id);
    return reply.status(204).send();
  });
};
