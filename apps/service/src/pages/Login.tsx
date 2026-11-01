import { useI18n } from "@jsudc/react";
import { Button } from "@jsudc/react/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ApiError, api } from "../lib/api.js";
import { AuthCard, Banner, Field, PasswordInput } from "../lib/ui.js";
import { ME_KEY, safeNext } from "../session.js";
import { type FieldErrors, hasErrors, serverErrors, validateNewPassword } from "./forms.js";

/** `/login?next=…`: email and password; success leads to `next` (a path of this site) or `/keys`. */
export function LoginPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/auth/login", { email, password });
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      navigate(safeNext(params.get("next")), { replace: true });
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 401
          ? t("AUTH", "BAD_LOGIN")
          : (serverErrors(e, t).form ?? t("AUTH", "BAD_LOGIN")),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t("AUTH", "LOGIN_TITLE")} testId="login">
      <form className="form" onSubmit={submit}>
        {error ? (
          <Banner tone="bad" testId="login-error">
            {error}
          </Banner>
        ) : null}
        <Field label={t("AUTH", "EMAIL")}>
          {(id) => (
            <input
              id={id}
              className="input"
              type="email"
              autoComplete="email"
              value={email}
              data-testid="login-email"
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Field label={t("AUTH", "PASSWORD")}>
          {(id) => (
            <PasswordInput
              id={id}
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
              testId="login-password"
            />
          )}
        </Field>
        <Button type="submit" variant="primary" disabled={busy} data-testid="login-submit">
          {t("AUTH", "LOGIN_SUBMIT")}
        </Button>
        <p className="auth__alt">
          <Link to="/forgot" data-testid="forgot-link">
            {t("AUTH", "FORGOT_LINK")}
          </Link>
          {" · "}
          {t("AUTH", "NO_ACCOUNT")} <Link to="/register">{t("APP", "REGISTER")}</Link>
        </p>
      </form>
    </AuthCard>
  );
}

/** `/forgot`: always the same answer, whether the address exists or not. */
export function ForgotPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/auth/forgot", { email });
      setSent(true);
    } catch (e) {
      setError(serverErrors(e, t).form ?? null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t("AUTH", "FORGOT_TITLE")} sub={t("AUTH", "FORGOT_SUB")} testId="forgot">
      {sent ? (
        <Banner tone="ok" testId="forgot-sent">
          {t("AUTH", "FORGOT_SENT")}
        </Banner>
      ) : (
        <form className="form" onSubmit={submit}>
          {error ? <Banner tone="bad">{error}</Banner> : null}
          <Field label={t("AUTH", "EMAIL")}>
            {(id) => (
              <input
                id={id}
                className="input"
                type="email"
                autoComplete="email"
                required
                value={email}
                data-testid="forgot-email"
                onChange={(e) => setEmail(e.target.value)}
              />
            )}
          </Field>
          <Button type="submit" variant="primary" disabled={busy} data-testid="forgot-submit">
            {t("AUTH", "FORGOT_SUBMIT")}
          </Button>
        </form>
      )}
      <p className="auth__alt">
        <Link to="/login">{t("AUTH", "TO_LOGIN")}</Link>
      </p>
    </AuthCard>
  );
}

/** `/reset/:token`: the new password twice. Every session ends; then log in again. */
export function ResetPage() {
  const { t } = useI18n();
  const { token = "" } = useParams();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = validateNewPassword(password, again, t);
    setErrors(found);
    if (hasErrors(found)) return;
    setBusy(true);
    try {
      await api("POST", "/auth/reset", { token, password });
      queryClient.setQueryData(ME_KEY, null);
      setDone(true);
    } catch (e) {
      setErrors(serverErrors(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title={t("AUTH", "RESET_TITLE")} testId="reset">
      {done ? (
        <>
          <Banner tone="ok" testId="reset-done">
            {t("AUTH", "RESET_DONE")}
          </Banner>
          <Link className="btn btn--primary" to="/login">
            {t("AUTH", "TO_LOGIN")}
          </Link>
        </>
      ) : (
        <form className="form" onSubmit={submit} noValidate>
          {errors.form || errors.token ? (
            <Banner tone="bad">{errors.form ?? errors.token}</Banner>
          ) : null}
          <Field
            label={t("AUTH", "NEW_PASSWORD")}
            hint={t("AUTH", "PASSWORD_HINT")}
            error={errors.password}
          >
            {(id, describedBy) => (
              <PasswordInput
                id={id}
                value={password}
                onChange={setPassword}
                autoComplete="new-password"
                describedBy={describedBy}
                testId="reset-password"
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
                testId="reset-again"
              />
            )}
          </Field>
          <Button type="submit" variant="primary" disabled={busy} data-testid="reset-submit">
            {t("AUTH", "RESET_SUBMIT")}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
