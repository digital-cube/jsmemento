import { useI18n } from "@jsudc/react";
import { Button, Dialog, DialogBody, DialogContent, DialogFooter } from "@jsudc/react/ui";
import { type FormEvent, useState } from "react";
import { API_BASE, api } from "../lib/api.js";
import { Banner, CopyButton, Field } from "../lib/ui.js";
import { serverErrors } from "../pages/forms.js";
import type { Limits } from "../session.js";
import { envLines, type KeyRow, newKeyBody } from "./keys.js";

interface Created {
  apiKey: KeyRow;
  key: string;
}

/**
 * "New key": name, scopes Read / Write (at least one), an optional expiry date, the daily limit
 * (prefilled with the server's default, at most its ceiling). On success the dialog shows the
 * key **once** — it is never shown again — with the two lines the client programs read.
 * Closing ends it; `onClosed` refetches the list.
 */
export function NewKeyDialog({
  open,
  limits,
  onClosed,
  origin = window.location.origin,
}: {
  open: boolean;
  limits: Limits;
  onClosed: (created: boolean) => void;
  origin?: string;
}) {
  const { t } = useI18n();
  const [created, setCreated] = useState<Created | null>(null);
  const close = () => {
    const was = created !== null;
    setCreated(null);
    onClosed(was);
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
      {created ? (
        <DialogContent
          title={t("NEW_KEY", "ONCE_TITLE")}
          data-mode="once"
          // A click beside the dialog must not lose a key that cannot be shown again.
          onInteractOutside={(e) => e.preventDefault()}
        >
          <OnceView created={created} origin={origin} onDone={close} />
        </DialogContent>
      ) : (
        <DialogContent title={t("NEW_KEY", "TITLE")} data-mode="form">
          <NewKeyForm limits={limits} onCreated={setCreated} onCancel={close} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function NewKeyForm({
  limits,
  onCreated,
  onCancel,
}: {
  limits: Limits;
  onCreated: (created: Created) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [read, setRead] = useState(true);
  const [write, setWrite] = useState(true);
  const [expires, setExpires] = useState("");
  const [dailyLimit, setDailyLimit] = useState(String(limits.default_daily_limit));
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const max = limits.max_daily_limit;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = newKeyBody({ name, read, write, expires, dailyLimit }, max);
    if (!parsed.ok) {
      const tr = (term: string | undefined, section = "NEW_KEY") =>
        term ? t(section, term, { max: max ?? "" }) : undefined;
      setErrors({
        name: parsed.errors.name ? t("AUTH", parsed.errors.name) : undefined,
        scopes: tr(parsed.errors.scopes),
        daily_limit: tr(parsed.errors.daily_limit),
      });
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const answer = await api<{ api_key: KeyRow; key: string }>("POST", "/keys", parsed.body);
      onCreated({ apiKey: answer.api_key, key: answer.key });
    } catch (error) {
      setErrors(serverErrors(error, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate data-testid="new-key-form">
      <DialogBody>
        <div className="form">
          {errors.form ? <Banner tone="bad">{errors.form}</Banner> : null}
          <Field label={t("NEW_KEY", "NAME")} hint={t("NEW_KEY", "NAME_HINT")} error={errors.name}>
            {(id, describedBy) => (
              <input
                id={id}
                className="input"
                value={name}
                aria-describedby={describedBy}
                data-testid="new-key-name"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <fieldset className="field" data-invalid={errors.scopes ? true : undefined}>
            <legend className="field__label">{t("NEW_KEY", "SCOPES")}</legend>
            <label className="check">
              <input
                type="checkbox"
                checked={read}
                data-testid="new-key-read"
                onChange={(e) => setRead(e.target.checked)}
              />
              {t("NEW_KEY", "READ")}
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={write}
                data-testid="new-key-write"
                onChange={(e) => setWrite(e.target.checked)}
              />
              {t("NEW_KEY", "WRITE")}
            </label>
            {errors.scopes ? (
              <span className="field__error" role="alert">
                {errors.scopes}
              </span>
            ) : null}
          </fieldset>
          <Field label={t("NEW_KEY", "EXPIRES")} error={errors.expires_at}>
            {(id) => (
              <input
                id={id}
                className="input"
                type="date"
                value={expires}
                data-testid="new-key-expires"
                onChange={(e) => setExpires(e.target.value)}
              />
            )}
          </Field>
          <Field
            label={t("NEW_KEY", "DAILY_LIMIT")}
            hint={max !== null ? t("NEW_KEY", "DAILY_MAX", { max }) : undefined}
            error={errors.daily_limit}
          >
            {(id, describedBy) => (
              <input
                id={id}
                className="input num"
                type="number"
                min={1}
                max={max ?? undefined}
                value={dailyLimit}
                aria-describedby={describedBy}
                data-testid="new-key-limit"
                onChange={(e) => setDailyLimit(e.target.value)}
              />
            )}
          </Field>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>
          {t("APP", "CANCEL")}
        </Button>
        <Button type="submit" variant="primary" disabled={busy} data-testid="new-key-submit">
          {t("NEW_KEY", "CREATE")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The key, this once, and the two lines for the client programs. */
export function OnceView({
  created,
  origin,
  onDone,
}: {
  created: Created;
  origin: string;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const env = envLines(origin, API_BASE, created.key);
  return (
    <>
      <DialogBody>
        <div className="once" data-testid="once-view">
          <p className="once__warning" role="note">
            {t("NEW_KEY", "ONCE")}
          </p>
          <div className="once__row">
            <code className="once__key mono" data-testid="once-key">
              {created.key}
            </code>
            <CopyButton text={created.key} label={t("NEW_KEY", "COPY_KEY")} testId="copy-key" />
          </div>
          <p>{t("NEW_KEY", "ENV")}</p>
          <div className="once__row">
            <pre className="once__env mono" data-testid="once-env">
              {env}
            </pre>
            <CopyButton text={env} label={t("NEW_KEY", "COPY_ENV")} testId="copy-env" />
          </div>
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="primary" onClick={onDone} data-testid="once-done">
          {t("NEW_KEY", "DONE")}
        </Button>
      </DialogFooter>
    </>
  );
}
