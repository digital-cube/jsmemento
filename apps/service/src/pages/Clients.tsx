import { useI18n } from "@jsudc/react";
import { Link } from "react-router";

/** `/clients`: planned — the client programs and how to configure them (a later ticket). */
export function ClientsPage() {
  const { t } = useI18n();
  return (
    <div className="page">
      <article className="planned" data-testid="planned" data-slug="clients">
        <span className="planned__badge">{t("PLANNED", "BADGE")}</span>
        <h1>{t("PLANNED", "CLIENTS_TITLE")}</h1>
        <p>{t("PLANNED", "CLIENTS_TEXT")}</p>
        <Link className="planned__back" to="/keys">
          {t("MENU", "KEYS")}
        </Link>
      </article>
    </div>
  );
}
