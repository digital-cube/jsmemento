import { UdcClient } from "@jsudc/core/client";
import { API_BASE } from "./api.js";

/**
 * The header the UDC client names the page's language in: memento renders the rows'
 * `rendered` text in it (`X-Memento-Locale`, docs/TEMPLATES.md).
 */
export const LOCALE_HEADER = "x-memento-locale";

/** `fetch` with the cookie: same origin needs no more, but say it anyway. */
const withCookie: typeof fetch = (input, init) => fetch(input, { ...init, credentials: "include" });

/**
 * The UDC client of the service site: no token — the `memento_session` cookie authenticates
 * every collection it reads (`api_keys`, `api_key_events`, …, `menu`).
 */
export function serviceUdcClient(locale: string, doFetch: typeof fetch = withCookie): UdcClient {
  return new UdcClient({
    httpUrl: API_BASE,
    headers: { [LOCALE_HEADER]: locale },
    fetch: doFetch,
  });
}
