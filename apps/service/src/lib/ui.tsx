import { intlLocaleOf, useI18n } from "@jsudc/react";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";

/** A labelled form field: the control (`children(id)`), a hint, and the error under it. */
export function Field({
  label,
  hint,
  error,
  children,
  testId,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: (id: string, describedBy: string | undefined) => ReactNode;
  testId?: string;
}) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="field" data-testid={testId} data-invalid={error ? true : undefined}>
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children(id, error ? errorId : undefined)}
      {hint && !error ? <span className="field__hint">{hint}</span> : null}
      {error ? (
        <span className="field__error" id={errorId} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** A password input with a Show / Hide toggle. */
export function PasswordInput({
  id,
  value,
  onChange,
  autoComplete,
  describedBy,
  testId,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  describedBy?: string | undefined;
  testId?: string;
}) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  return (
    <span className="password">
      <input
        id={id}
        className="input"
        type={shown ? "text" : "password"}
        value={value}
        autoComplete={autoComplete}
        aria-describedby={describedBy}
        aria-invalid={describedBy ? true : undefined}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="password__toggle"
        aria-pressed={shown}
        onClick={() => setShown((s) => !s)}
        data-testid={testId ? `${testId}-toggle` : undefined}
      >
        {shown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
        {shown ? t("AUTH", "HIDE") : t("AUTH", "SHOW")}
      </button>
    </span>
  );
}

export type Tone = "ok" | "warn" | "bad" | "muted" | "info";

export function Chip({ tone = "muted", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span className="chip" data-tone={tone}>
      {children}
    </span>
  );
}

/** `used / limit` as a small bar: green, amber past 80 %, red at the limit. */
export function UsageBar({ used, limit }: { used: number; limit: number | null }) {
  const { locale } = useI18n();
  const fmt = new Intl.NumberFormat(intlLocaleOf(locale));
  const ratio = limit && limit > 0 ? Math.min(1, used / limit) : 0;
  const tone = ratio >= 1 ? "bad" : ratio >= 0.8 ? "warn" : "ok";
  return (
    <span className="usage" data-tone={tone} data-testid="usage-bar">
      <span className="usage__track" aria-hidden>
        <span className="usage__fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
      </span>
      <span className="usage__text num">
        {fmt.format(used)} / {limit === null ? "∞" : fmt.format(limit)}
      </span>
    </span>
  );
}

/** Copies `text` to the clipboard; says so for two seconds. */
export function CopyButton({
  text,
  label,
  testId,
}: {
  text: string;
  label?: string;
  testId?: string;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button type="button" className="btn btn--ghost copy" onClick={copy} data-testid={testId}>
      {copied ? (
        <Check aria-hidden className="btn__icon" />
      ) : (
        <Copy aria-hidden className="btn__icon" />
      )}
      {copied ? t("APP", "COPIED") : (label ?? t("APP", "COPY"))}
    </button>
  );
}

/** A date and time in the page's language; `—` for none. */
export function useDateTime(): (iso: unknown) => string {
  const { locale } = useI18n();
  const fmt = new Intl.DateTimeFormat(intlLocaleOf(locale), {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: false,
  });
  return (iso) => {
    if (typeof iso !== "string" || iso === "") return "—";
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? "—" : fmt.format(at);
  };
}

/** A narrow page of its own: the forms of /register, /login, /forgot, /reset, /verify. */
export function AuthCard({
  title,
  sub,
  children,
  testId,
}: {
  title: ReactNode;
  sub?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="page">
      <section className="auth" data-testid={testId}>
        <h1>{title}</h1>
        {sub ? <p className="auth__sub">{sub}</p> : null}
        {children}
      </section>
    </div>
  );
}

/** A message over a page: `info` (a hint) or `bad` (an error). */
export function Banner({
  tone = "info",
  children,
  testId,
}: {
  tone?: "info" | "bad" | "ok";
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="banner"
      data-tone={tone}
      role={tone === "bad" ? "alert" : "status"}
      data-testid={testId}
    >
      {children}
    </div>
  );
}
