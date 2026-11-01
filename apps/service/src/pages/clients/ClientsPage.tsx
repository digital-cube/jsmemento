import CLIENTS from "virtual:clients";
import { storage, useI18n } from "@jsudc/react";
import { Download } from "lucide-react";
import { Tabs } from "radix-ui";
import { Fragment, type ReactNode, useEffect } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { API_BASE } from "../../lib/api.js";
import { CopyButton } from "../../lib/ui.js";
import { useMe } from "../../session.js";
import type { ClientFile, ClientProgram, ReadmeBlock } from "./types.js";

/** The language picked last, for the next visit to `/clients`. */
export const CLIENTS_LANG_STORAGE_KEY = "memento.service.clients.lang";

const byId = (id: string | undefined) => CLIENTS.find((p) => p.id === id);

/** `MEMENTO_URL` for this site: the API under this origin (or the configured absolute base). */
export function mementoUrl(origin: string = location.origin): string {
  return /^https?:\/\//.test(API_BASE) ? API_BASE : `${origin}${API_BASE}`;
}

/** The two lines the Copy button of the environment block copies; never a real key. */
export function envLines(origin?: string): string {
  return `MEMENTO_URL=${mementoUrl(origin)}\nMEMENTO_API_KEY=mk_…`;
}

/**
 * `/clients` and `/clients/:lang` (public): the eight client programs of `clients/` — a tab
 * per language, the two environment variables, the README's install / variables / run, the
 * program's source and its zip. The content is `virtual:clients`, built from the repository
 * by vite-plugin-clients; no key is ever on this page.
 */
export function ClientsPage() {
  const { t } = useI18n();
  const { lang } = useParams();
  const navigate = useNavigate();
  const program = byId(lang);
  // The URL decides; the last language shown is also the one `/clients` opens next time.
  useEffect(() => {
    if (program) storage.set(CLIENTS_LANG_STORAGE_KEY, program.id);
  }, [program]);
  if (!program) {
    const stored = byId(storage.get(CLIENTS_LANG_STORAGE_KEY) ?? undefined);
    return <Navigate to={`/clients/${(stored ?? CLIENTS[0])?.id ?? ""}`} replace />;
  }
  const pick = (id: string) => navigate(`/clients/${id}`);
  return (
    <div className="page">
      <article className="clients" data-testid="clients">
        <h1>{t("CLIENTS", "TITLE")}</h1>
        <p className="clients__intro">{t("CLIENTS", "INTRO")}</p>
        <Tabs.Root value={program.id} onValueChange={pick} activationMode="manual">
          <Tabs.List
            className="clients__langs"
            aria-label={t("CLIENTS", "LANGUAGES")}
            data-testid="clients-langs"
          >
            {CLIENTS.map((p) => (
              <Tabs.Trigger
                key={p.id}
                value={p.id}
                className="clients__lang"
                data-testid={`clients-tab-${p.id}`}
              >
                {p.label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          {CLIENTS.map((p) => (
            <Tabs.Content key={p.id} value={p.id} className="clients__panel">
              <Program program={p} />
            </Tabs.Content>
          ))}
        </Tabs.Root>
      </article>
    </div>
  );
}

function Program({ program }: { program: ClientProgram }) {
  const { t } = useI18n();
  const zip = `${import.meta.env.BASE_URL}clients/${program.id}.zip`;
  return (
    <div className="clients__program" data-testid={`clients-panel-${program.id}`}>
      <EnvBlock />
      <section className="clients__readme" data-testid="clients-readme">
        <ReadmeSection title={t("CLIENTS", "INSTALL")} blocks={program.readme.install} />
        <ReadmeSection title={t("CLIENTS", "VARIABLES")} blocks={program.readme.variables} />
        <ReadmeSection title={t("CLIENTS", "RUN")} blocks={program.readme.run} />
      </section>
      <Sources program={program} />
      <div className="clients__download">
        <a
          className="btn btn--primary"
          href={zip}
          download={`${program.id}.zip`}
          data-testid="clients-download"
        >
          <Download aria-hidden className="btn__icon" />
          {t("CLIENTS", "DOWNLOAD")} {program.id}.zip
        </a>
        <span className="clients__zip" data-testid="clients-zip">
          {program.zip.join(" · ")}
        </span>
      </div>
    </div>
  );
}

/** `MEMENTO_URL` with this origin and the key placeholder; the hint says where keys come from. */
function EnvBlock() {
  const { t } = useI18n();
  const { me } = useMe();
  const lines = envLines();
  return (
    <section className="clients__env" data-testid="clients-env">
      <h2>{t("CLIENTS", "ENV_TITLE")}</h2>
      <div className="clients__envrow">
        <pre className="mono clients__envlines" data-testid="clients-env-lines">
          {lines.split("\n").map((line, i) => (
            <Fragment key={line}>
              {line}
              {i === 1 ? (
                <span className="clients__hint" data-testid="clients-env-hint">
                  {"   ← "}
                  {me ? (
                    <Link to="/keys">{t("CLIENTS", "HINT_KEYS")}</Link>
                  ) : me === null ? (
                    <>
                      {t("CLIENTS", "HINT_REGISTER_BEFORE")}{" "}
                      <Link to="/register">{t("CLIENTS", "HINT_REGISTER_LINK")}</Link>
                    </>
                  ) : (
                    t("CLIENTS", "HINT_KEY")
                  )}
                </span>
              ) : (
                "\n"
              )}
            </Fragment>
          ))}
        </pre>
        <CopyButton text={lines} testId="clients-copy-env" />
      </div>
      <p className="clients__note">{t("CLIENTS", "ENV_NOTE")}</p>
    </section>
  );
}

function ReadmeSection({ title, blocks }: { title: string; blocks: ReadmeBlock[] }) {
  return (
    <div className="clients__section">
      <h3>{title}</h3>
      {blocks.map((block, i) =>
        block.kind === "code" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, never reordered.
          <pre key={i} className="mono clients__snippet">
            {block.code}
          </pre>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, never reordered.
          <p key={i}>{inline(block.text)}</p>
        ),
      )}
    </div>
  );
}

/** A README line's inline markdown: `code` and [text](https://…) links; the rest as text. */
export function inline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      m[1] !== undefined ? (
        <code key={m.index}>{m[1]}</code>
      ) : (
        <a key={m.index} href={m[3]} target="_blank" rel="noreferrer">
          {m[2]}
        </a>
      ),
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** The main file, and the manifest beside it as a second tab when the program has one. */
function Sources({ program }: { program: ClientProgram }) {
  const { t } = useI18n();
  const [main] = program.files;
  if (!main) return null;
  return (
    <section className="clients__source" data-testid="clients-source">
      <h2>{t("CLIENTS", "SOURCE")}</h2>
      {program.files.length === 1 ? (
        <SourceFile file={main} />
      ) : (
        <Tabs.Root defaultValue={main.name} key={program.id}>
          <Tabs.List className="clients__files" aria-label={t("CLIENTS", "FILES")}>
            {program.files.map((f) => (
              <Tabs.Trigger
                key={f.name}
                value={f.name}
                className="clients__file"
                data-testid={`clients-file-${f.name}`}
              >
                {f.name}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          {program.files.map((f) => (
            <Tabs.Content key={f.name} value={f.name}>
              <SourceFile file={f} />
            </Tabs.Content>
          ))}
        </Tabs.Root>
      )}
    </section>
  );
}

/**
 * A file with line numbers (CSS counters over `.line`) and Copy. The HTML is shiki's, made at
 * build time from the repository's own files; without it, the plain text in the same lines.
 */
function SourceFile({ file }: { file: ClientFile }) {
  return (
    <div className="code" data-testid="clients-code" data-file={file.name}>
      <div className="code__head">
        <span className="mono">{file.name}</span>
        <CopyButton text={file.source} testId="clients-copy-source" />
      </div>
      {file.html ? (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output of committed files, built by vite-plugin-clients.
        <div className="code__body" dangerouslySetInnerHTML={{ __html: file.html }} />
      ) : (
        <div className="code__body">
          <pre className="shiki">
            <code>
              {file.source
                .replace(/\n$/, "")
                .split("\n")
                .map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines of one file, in order.
                  <Fragment key={i}>
                    <span className="line">{line}</span>
                    {"\n"}
                  </Fragment>
                ))}
            </code>
          </pre>
        </div>
      )}
    </div>
  );
}
