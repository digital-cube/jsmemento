import { type Locale, useI18n } from "@jsudc/react";
import { Button, useToast } from "@jsudc/react/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { VerifyBanner } from "../keys/KeysPage.js";
import { api } from "../lib/api.js";
import { Banner, Chip, Field, PasswordInput } from "../lib/ui.js";
import { type FieldErrors, hasErrors, serverErrors, validateNewPassword } from "../pages/forms.js";
import { ME_KEY, useSignedIn } from "../session.js";
import { useLogOut } from "../shell/ServiceShell.js";

/**
 * `/account`: name and locale (`PATCH /auth/me`), the password (current + new), the tenant's
 * name and slug (read-only), "resend verification" while the address is not verified, Log out.
 */
export function AccountPage() {
  const { t } = useI18n();
  const me = useSignedIn();
  const logOut = useLogOut();
  return (
    <div className="page">
      <header className="bar">
        <div className="bar__title">
          <h1>{t("ACCOUNT", "TITLE")}</h1>
          <span className="bar__sub">{me.user.email}</span>
        </div>
        <Button onClick={logOut} data-testid="account-logout">
          {t("APP", "LOG_OUT")}
        </Button>
      </header>
      {me.user.email_verified ? null : <VerifyBanner email={me.user.email} />}
      <div className="cards">
        <Profile />
        <ChangePassword />
        <section className="panel" data-testid="account-tenant">
          <h2>{t("ACCOUNT", "TENANT")}</h2>
          <dl className="facts">
            <dt>{t("ACCOUNT", "TENANT_NAME")}</dt>
            <dd>{me.tenant.name}</dd>
            <dt>{t("ACCOUNT", "TENANT_SLUG")}</dt>
            <dd>
              <code className="mono">{me.tenant.slug}</code>
            </dd>
            <dt>{t("AUTH", "EMAIL")}</dt>
            <dd>
              {me.user.email}{" "}
              <Chip tone={me.user.email_verified ? "ok" : "warn"}>
                {t("ACCOUNT", me.user.email_verified ? "VERIFIED" : "UNVERIFIED")}
              </Chip>
            </dd>
          </dl>
        </section>
      </div>
    </div>
  );
}

function Profile() {
  const { t, locales, setLocale: setHeaderLocale } = useI18n();
  const { toast } = useToast();
  const me = useSignedIn();
  const queryClient = useQueryClient();
  const [name, setName] = useState(me.user.name);
  const [locale, setLocale] = useState(me.user.locale);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return setErrors({ name: t("AUTH", "REQUIRED") });
    setErrors({});
    setBusy(true);
    try {
      await api("PATCH", "/auth/me", { name: name.trim(), locale });
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      if ((locales as readonly string[]).includes(locale)) setHeaderLocale(locale as Locale);
      toast({ title: t("APP", "SAVED"), variant: "success" });
    } catch (error) {
      setErrors(serverErrors(error, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel" data-testid="account-profile">
      <h2>{t("ACCOUNT", "PROFILE")}</h2>
      <form className="form" onSubmit={submit} noValidate>
        {errors.form ? <Banner tone="bad">{errors.form}</Banner> : null}
        <Field label={t("AUTH", "NAME")} error={errors.name}>
          {(id, describedBy) => (
            <input
              id={id}
              className="input"
              value={name}
              aria-describedby={describedBy}
              data-testid="account-name"
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label={t("AUTH", "LOCALE")} error={errors.locale}>
          {(id) => (
            <select
              id={id}
              className="input"
              value={locale}
              data-testid="account-locale"
              onChange={(e) => setLocale(e.target.value)}
            >
              {locales.map((l) => (
                <option key={l} value={l}>
                  {l.toUpperCase()}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Button type="submit" variant="primary" disabled={busy} data-testid="account-save">
          {t("APP", "SAVE")}
        </Button>
      </form>
    </section>
  );
}

function ChangePassword() {
  const { t } = useI18n();
  const { toast } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found: FieldErrors = current
      ? validateNewPassword(next, again, t)
      : { current: t("AUTH", "REQUIRED") };
    setErrors(found);
    if (hasErrors(found)) return;
    setBusy(true);
    try {
      await api("PATCH", "/auth/me", { password: { current, next } });
      setCurrent("");
      setNext("");
      setAgain("");
      toast({ title: t("ACCOUNT", "CHANGED"), variant: "success" });
    } catch (error) {
      setErrors(serverErrors(error, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel" data-testid="account-password">
      <h2>{t("ACCOUNT", "PASSWORD")}</h2>
      <form className="form" onSubmit={submit} noValidate>
        {errors.form ? <Banner tone="bad">{errors.form}</Banner> : null}
        <Field label={t("ACCOUNT", "CURRENT")} error={errors.current}>
          {(id, describedBy) => (
            <PasswordInput
              id={id}
              value={current}
              onChange={setCurrent}
              autoComplete="current-password"
              describedBy={describedBy}
              testId="password-current"
            />
          )}
        </Field>
        <Field
          label={t("AUTH", "NEW_PASSWORD")}
          hint={t("AUTH", "PASSWORD_HINT")}
          error={errors.password ?? errors.next}
        >
          {(id, describedBy) => (
            <PasswordInput
              id={id}
              value={next}
              onChange={setNext}
              autoComplete="new-password"
              describedBy={describedBy}
              testId="password-next"
            />
          )}
        </Field>
        <Field label={t("AUTH", "PASSWORD_AGAIN")} error={errors.again}>
          {(id, describedBy) => (
            <PasswordInput
              id={id}
              value={again}
              onChange={setAgain}
              autoComplete="new-password"
              describedBy={describedBy}
              testId="password-again"
            />
          )}
        </Field>
        <Button type="submit" variant="primary" disabled={busy} data-testid="password-save">
          {t("ACCOUNT", "CHANGE")}
        </Button>
      </form>
    </section>
  );
}
