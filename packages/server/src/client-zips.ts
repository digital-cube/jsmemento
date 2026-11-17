import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";

/**
 * The service every client program of `clients/<lang>/` names in its source: the default
 * `MEMENTO_URL` (`<origin>/memento`) and the page where a key is created (`<origin>/keys`).
 * The service site builds its `/clients/<lang>.zip` from those sources unchanged; the server
 * that serves them swaps this origin for its own `MEMENTO_SERVICE_URL` ({@link localizeZip}),
 * so stage's zips name stage and production's name production.
 */
export const CLIENTS_SERVICE_URL = "https://service.memento-service.org";

/** Same as the service site's zips (apps/service/vite-plugin-clients.ts): same input, same bytes. */
const ZIP_MTIME = new Date("2026-01-01T00:00:00Z");

const CANONICAL = Buffer.from(CLIENTS_SERVICE_URL, "utf8");

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function includes(haystack: Uint8Array, needle: Buffer): boolean {
  return Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength).includes(needle);
}

/** The entry as text, or `null` when it is not UTF-8 (a binary keeps its bytes). */
function textOf(data: Uint8Array): string | null {
  try {
    return UTF8.decode(data);
  } catch {
    return null;
  }
}

/**
 * `zip` with {@link CLIENTS_SERVICE_URL} replaced by `serviceUrl` in every text (UTF-8) entry
 * that names it; the other entries keep their bytes. The same zip back when `serviceUrl` is that origin
 * or no entry names it.
 */
export function localizeZip(zip: Uint8Array, serviceUrl: string): Uint8Array {
  const target = serviceUrl.replace(/\/+$/, "");
  if (target === CLIENTS_SERVICE_URL) return zip;
  const entries = unzipSync(zip);
  let changed = false;
  const out: Record<string, [Uint8Array, { mtime: Date }]> = {};
  for (const [name, data] of Object.entries(entries)) {
    let bytes = data;
    const text = includes(data, CANONICAL) ? textOf(data) : null;
    if (text !== null) {
      bytes = strToU8(text.replaceAll(CLIENTS_SERVICE_URL, target));
      changed = true;
    }
    out[name] = [bytes, { mtime: ZIP_MTIME }];
  }
  return changed ? zipSync(out, { level: 9 }) : zip;
}

/**
 * Every `clients/*.zip` of a built UI directory, localized to `serviceUrl`, by request path
 * (`/clients/javascript.zip`). Empty when the directory has no `clients/`.
 */
export function localizedClientZips(uiRoot: string, serviceUrl: string): Map<string, Buffer> {
  const dir = join(uiRoot, "clients");
  const zips = new Map<string, Buffer>();
  if (!existsSync(dir)) return zips;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".zip")) continue;
    const zip = localizeZip(readFileSync(join(dir, name)), serviceUrl);
    zips.set(`/clients/${name}`, Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength));
  }
  return zips;
}
