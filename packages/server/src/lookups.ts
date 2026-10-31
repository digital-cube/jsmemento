import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventCreate } from "@memento/core";
import {
  CandidateRecorder,
  type CodegenOptions,
  type CsvIssue,
  LookupRegistry,
  loadLookups,
} from "@memento/lookups";

/** The lookup sections memento checks events against. */
export const LOOKUP_SECTIONS = {
  eventType: "EventTypes",
  instanceType: "InstanceTypes",
  /** Taken from `payload.actor_type` when the producer sends one. */
  actorType: "ActorTypes",
} as const;

/** How memento's vocabulary is turned into `@memento/core`'s typed lookups. */
export const LOOKUPS_CODEGEN: CodegenOptions = {
  lowercase: [LOOKUP_SECTIONS.instanceType, LOOKUP_SECTIONS.actorType],
  source: "lookups.yaml",
};

/** `lookups.yaml` at the repository root (same depth from `src/` and `dist/`). */
export const DEFAULT_LOOKUPS_PATH = fileURLToPath(
  new URL("../../../lookups.yaml", import.meta.url),
);

/** Where `memento lookups codegen` writes the typed lookups. */
export const GENERATED_LOOKUPS_PATH = fileURLToPath(
  new URL("../../core/src/lookups.generated.ts", import.meta.url),
);

export interface Lookups {
  registry: LookupRegistry;
  /** `null` when candidate recording is off. */
  recorder: CandidateRecorder | null;
  /** Reject events whose event_type / instance_type is not in the vocabulary. */
  strict: boolean;
}

/** No vocabulary: nothing is checked, recorded or translated. */
export function emptyLookups(): Lookups {
  return { registry: new LookupRegistry(), recorder: null, strict: false };
}

export interface InitLookupsOptions {
  /** `lookups.yaml`. */
  path: string;
  /** Default `<dir of path>/i18n/translations.csv`; a missing file is fine. */
  translationsPath?: string;
  /** Default `<dir of path>/var/candidates`; `null` disables recording. */
  candidatesDir?: string | null;
  strict?: boolean;
  locales?: readonly string[];
  /** Candidate recording failures (best effort, never fail a push). */
  onError?: (error: unknown) => void;
}

/** Loads the vocabulary and its translations, and wires the candidate recorder. */
export async function initLookups(
  options: InitLookupsOptions,
): Promise<Lookups & { warnings: CsvIssue[] }> {
  const root = dirname(options.path);
  const { registry, warnings } = await loadLookups({
    path: options.path,
    translationsPath: options.translationsPath ?? join(root, "i18n", "translations.csv"),
  });
  const candidatesDir =
    options.candidatesDir === undefined ? join(root, "var", "candidates") : options.candidatesDir;
  const recorder =
    candidatesDir === null
      ? null
      : new CandidateRecorder({
          dir: candidatesDir,
          registry,
          ...(options.locales ? { locales: options.locales } : {}),
          ...(options.onError ? { onError: options.onError } : {}),
        });
  return { registry, recorder, strict: options.strict ?? false, warnings };
}

function actorType(event: EventCreate): string | null {
  const value = event.payload.actor_type;
  return typeof value === "string" && value ? value : null;
}

/** The lookup values of an event that the vocabulary does not know, as `section → value`. */
export function unknownLookups(lookups: Lookups, event: EventCreate): Record<string, string> {
  const unknown: Record<string, string> = {};
  const check = (section: string, value: string | null) => {
    if (value && !lookups.registry.has(section, value)) unknown[section] = value;
  };
  check(LOOKUP_SECTIONS.eventType, event.event_type);
  check(LOOKUP_SECTIONS.instanceType, event.instance_type);
  check(LOOKUP_SECTIONS.actorType, actorType(event));
  return unknown;
}

/** Records the event's unknown lookup values as candidates (best effort). */
export async function recordCandidates(lookups: Lookups, event: EventCreate): Promise<void> {
  const recorder = lookups.recorder;
  if (!recorder) return;
  await Promise.all(
    Object.entries(unknownLookups(lookups, event)).map(([section, value]) =>
      recorder.record(section, value),
    ),
  );
}
