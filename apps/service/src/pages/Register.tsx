import { type Locale, useI18n } from "@jsudc/react";
import { Button } from "@jsudc/react/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, api } from "../lib/api.js";
import { AuthCard, Banner, Field, PasswordInput } from "../lib/ui.js";
import { ME_KEY } from "../session.js";
import { type FieldErrors, hasErrors, serverErrors, validateRegister } from "./forms.js";

/**
 * `/register`: email, password (min 10, show/hide), name, locale (the header's by default) and
 * the terms. The server's errors land under their fields; `409` says the email is taken, with
 * a link to log in. Success signs in and leads to `/keys`, where the "verify your address"
 * banner waits.
 */
export function RegisterPage() {
  const { t, locale: headerLocale, locales } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [locale, setLocale] = useState<Locale>(headerLocale);
  const [terms, setTerms] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [taken, setTaken] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = validateRegister({ email, password, name, terms }, t);
    setErrors(found);
    setTaken(false);
    if (hasErrors(found)) return;
    setBusy(true);
    try {
      await api("POST", "/auth/register", { email, password, name, locale, terms });
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      navigate("/keys");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setTaken(true);
        setErrors({});
      } else {
        setErrors(serverErrors(error, t));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t("AUTH", "REGISTER_TITLE")} sub={t("AUTH", "REGISTER_SUB")} testId="register">
      <form className="form" onSubmit={submit} noValidate>
        {errors.form ? <Banner tone="bad">{errors.form}</Banner> : null}
        <Field
          label={t("AUTH", "EMAIL")}
          error={
            taken ? (
              <span data-testid="email-taken">
                {t("AUTH", "EMAIL_TAKEN")}{" "}
                <Link to={`/login?email=${encodeURIComponent(email)}`}>
                  {t("AUTH", "EMAIL_TAKEN_LOGIN")}
                </Link>
              </span>
            ) : (
              errors.email
            )
          }
          testId="field-email"
        >
          {(id, describedBy) => (
            <input
              id={id}
              className="input"
              type="email"
              autoComplete="email"
              value={email}
              aria-describedby={describedBy}
              data-testid="register-email"
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Field
          label={t("AUTH", "PASSWORD")}
          hint={t("AUTH", "PASSWORD_HINT")}
          error={errors.password}
          testId="field-password"
        >
          {(id, describedBy) => (
            <PasswordInput
              id={id}
              value={password}
              onChange={setPassword}
              autoComplete="new-password"
              describedBy={describedBy}
              testId="register-password"
            />
          )}
        </Field>
        <Field label={t("AUTH", "NAME")} error={errors.name} testId="field-name">
          {(id, describedBy) => (
            <input
              id={id}
              className="input"
              autoComplete="name"
              value={name}
              aria-describedby={describedBy}
              data-testid="register-name"
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
              data-testid="register-locale"
              onChange={(e) => setLocale(e.target.value as Locale)}
            >
              {locales.map((l) => (
                <option key={l} value={l}>
                  {l.toUpperCase()}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="field" data-invalid={errors.terms ? true : undefined}>
          <label className="check">
            <input
              type="checkbox"
              checked={terms}
              data-testid="register-terms"
              onChange={(e) => setTerms(e.target.checked)}
            />
            <span>
              {t("AUTH", "TERMS_BEFORE")}{" "}
              <Link to="/terms" target="_blank">
                {t("AUTH", "TERMS_LINK")}
              </Link>
            </span>
          </label>
          {errors.terms ? (
            <span className="field__error" role="alert">
              {errors.terms}
            </span>
          ) : null}
        </div>
        <Button type="submit" variant="primary" disabled={busy} data-testid="register-submit">
          {t("AUTH", "REGISTER_SUBMIT")}
        </Button>
        <p className="auth__alt">
          {t("AUTH", "HAVE_ACCOUNT")} <Link to="/login">{t("AUTH", "TO_LOGIN")}</Link>
        </p>
      </form>
    </AuthCard>
  );
}
