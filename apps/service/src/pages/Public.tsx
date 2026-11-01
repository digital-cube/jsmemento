import { useI18n } from "@jsudc/react";
import { Spinner } from "@jsudc/react/ui";
import { Link, Navigate } from "react-router";
import { useMe } from "../session.js";

/** `/`: what memento is, Register and Log in; a signed-in user goes to their keys. */
export function HomePage() {
  const { t } = useI18n();
  const { me } = useMe();
  if (me === undefined) {
    return (
      <div className="page__center">
        <Spinner />
      </div>
    );
  }
  if (me) return <Navigate to="/keys" replace />;
  return (
    <div className="page">
      <section className="hero" data-testid="home">
        <h1>{t("HOME", "TITLE")}</h1>
        <p>{t("HOME", "P1")}</p>
        <p>{t("HOME", "P2")}</p>
        <p>{t("HOME", "P3")}</p>
        <div className="hero__actions">
          <Link className="btn btn--primary" to="/register" data-testid="home-register">
            {t("APP", "REGISTER")}
          </Link>
          <Link className="btn" to="/login" data-testid="home-login">
            {t("APP", "LOG_IN")}
          </Link>
        </div>
      </section>
    </div>
  );
}

/** `/terms`: public, a placeholder until the real text exists. */
export function TermsPage() {
  const { t } = useI18n();
  return (
    <div className="page">
      <article className="prose" data-testid="terms">
        <h1>{t("TERMS", "TITLE")}</h1>
        <p>{t("TERMS", "PLACEHOLDER")}</p>
      </article>
    </div>
  );
}
