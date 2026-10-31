import { useI18n } from "@jsudc/react";
import { Link, Navigate, useParams } from "react-router";
import { localized, PLANNED_EXAMPLES } from "./planned.js";

/**
 * `/examples/:slug` for an example of menu.yaml that is not built yet: what it will show,
 * and the way back to one that is. An unknown slug leads home.
 */
export function PlannedExamplePage() {
  const { slug = "" } = useParams();
  const { t, locale } = useI18n();
  const planned = Object.hasOwn(PLANNED_EXAMPLES, slug) ? PLANNED_EXAMPLES[slug] : undefined;
  if (!planned) return <Navigate to="/" replace />;
  return (
    <div className="page">
      <article className="planned" data-testid="planned" data-slug={slug}>
        <span className="planned__badge">{t("PLANNED", "BADGE")}</span>
        <h1>{localized(planned.title, locale)}</h1>
        <p className="planned__lead">{t("PLANNED", "LEAD")}</p>
        <p>{localized(planned.summary, locale)}</p>
        <Link className="planned__back" to="/examples/activity">
          {t("PLANNED", "BACK")}
        </Link>
      </article>
    </div>
  );
}
