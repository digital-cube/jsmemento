/** Up to two letters for an avatar: `igor` → `IG`, `ana marija` → `AM`. */
export function initials(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return (words[0] as string).slice(0, 2).toUpperCase();
  return `${(words[0] as string)[0]}${(words[1] as string)[0]}`.toUpperCase();
}

/** A stable hue (0–359) for a user id, so one person keeps one avatar colour. */
export function hue(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  // Mix the bits, so similar ids (Igor, Marko) do not land on neighbouring hues.
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  hash = Math.imul(hash ^ (hash >>> 16), 0x45d9f3b);
  return ((hash ^ (hash >>> 16)) >>> 0) % 360;
}

export interface TimeFormat {
  /** BCP 47 locale for dates. Default: the browser's. */
  locale?: string | undefined;
  /** IANA zone, e.g. `Europe/Belgrade`. Default: the browser's. */
  timeZone?: string | undefined;
}

export function formatDate(iso: string, format: TimeFormat = {}): string {
  return new Intl.DateTimeFormat(format.locale, {
    dateStyle: "medium",
    ...(format.timeZone ? { timeZone: format.timeZone } : {}),
  }).format(new Date(iso));
}

export function formatTime(iso: string, format: TimeFormat = {}): string {
  return new Intl.DateTimeFormat(format.locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    ...(format.timeZone ? { timeZone: format.timeZone } : {}),
  }).format(new Date(iso));
}
