import { udcKeys, useUdcClient } from "@jsudc/react";
import { useQuery } from "@tanstack/react-query";
import { type KeyRow, keyOf } from "./keys.js";

/**
 * How often the key page asks again. The examples site refetches when memento's WebSocket
 * stream says so; the stream takes an API key and this site has only the session cookie, so
 * the key page polls instead (docs/DEPLOYMENT.md "The service site").
 */
export const POLL_MS = 10_000;

export const KEYS_COLLECTION = "api_keys";

/** The query key of one key: under the collection's lists, so refetching them refetches it. */
export const keyQueryKey = (collection: string, id: string) =>
  [...udcKeys.lists(collection), "read", id] as const;

/** One row of `api_keys` (or `admin_api_keys`) by id: UDC `read`, polled. */
export function useKey(id: string, collection = KEYS_COLLECTION) {
  const client = useUdcClient();
  return useQuery<KeyRow, Error>({
    queryKey: keyQueryKey(collection, id),
    queryFn: async () => keyOf((await client.call("read", { collection, id })).row),
    refetchInterval: POLL_MS,
    retry: false,
  });
}
