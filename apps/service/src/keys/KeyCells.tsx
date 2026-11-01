import { useI18n } from "@jsudc/react";
import { Chip, UsageBar } from "../lib/ui.js";
import { type KeyStatus, statusTerm, statusTone } from "./keys.js";

export function StatusChip({ status }: { status: KeyStatus }) {
  const { t } = useI18n();
  return (
    <span data-testid="status-chip" data-status={status}>
      <Chip tone={statusTone(status)}>{t("KEYS", statusTerm(status))}</Chip>
    </span>
  );
}

export function ScopeChips({ scopes }: { scopes: readonly string[] }) {
  const { t } = useI18n();
  return (
    <span className="chips">
      {scopes.map((s) => (
        <Chip key={s} tone="info">
          {t("KEYS", `SCOPE_${s.toUpperCase()}`)}
        </Chip>
      ))}
    </span>
  );
}

export { UsageBar };
