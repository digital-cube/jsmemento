import { UdcDataView, udcKeys, useI18n, useUdcCollection } from "@jsudc/react";
import { Button, Tip } from "@jsudc/react/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api.js";
import { Banner } from "../lib/ui.js";
import { maxKeysOf, useSignedIn } from "../session.js";
import { KEYS_RENDERERS } from "./KeysTable.js";
import { newKeyBlock } from "./keys.js";
import { NewKeyDialog } from "./NewKeyDialog.js";
import { KEYS_COLLECTION } from "./useKey.js";

/**
 * `/keys`: the tenant's API keys (`api_keys`, a `UdcDataView` with this site's table) and
 * "New key" — disabled, with the reason, while the address is not verified or the tenant holds
 * as many live keys as it may.
 */
export function KeysPage() {
  const { t } = useI18n();
  const me = useSignedIn();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  // The live keys (not revoked; deleted ones are not in the collection): what max_keys counts.
  const live = useUdcCollection({
    collection: KEYS_COLLECTION,
    filter: { field: "status", op: "neq", value: "revoked" },
    mode: "pages",
    pageLimit: 1,
    capabilities: { paging: ["offset"] },
  });
  const max = maxKeysOf(me);
  const block = newKeyBlock(me.user.email_verified, live.total, max);
  const why =
    block === "unverified"
      ? t("KEYS", "WHY_UNVERIFIED")
      : block === "max"
        ? t("KEYS", "WHY_MAX", { max })
        : null;

  const closed = () => {
    setOpen(false);
    void queryClient.invalidateQueries({ queryKey: udcKeys.lists(KEYS_COLLECTION) });
  };

  const newKey = (
    <Button
      variant="primary"
      disabled={block !== null}
      onClick={() => setOpen(true)}
      data-testid="new-key"
    >
      <Plus aria-hidden className="btn__icon" />
      {t("KEYS", "NEW")}
    </Button>
  );

  return (
    <div className="page">
      <header className="bar">
        <div className="bar__title">
          <h1>{t("KEYS", "TITLE")}</h1>
          <span className="bar__sub">{t("KEYS", "SUB", { tenant: me.tenant.slug })}</span>
        </div>
        <div className="bar__actions">
          {live.total !== null ? (
            <span className="bar__count num" data-testid="key-count">
              {t("KEYS", "COUNT", { count: live.total, max })}
            </span>
          ) : null}
          {why ? (
            <Tip label={why}>
              <span data-testid="new-key-why" title={why}>
                {newKey}
              </span>
            </Tip>
          ) : (
            newKey
          )}
        </div>
      </header>
      {/* Unverified: the banner below says why (and offers to send the mail again). */}
      {block === "max" ? (
        <p className="bar__why" data-testid="new-key-reason">
          {why}
        </p>
      ) : null}
      {me.user.email_verified ? null : <VerifyBanner email={me.user.email} />}
      <section className="view">
        <UdcDataView collection={KEYS_COLLECTION} renderers={KEYS_RENDERERS} />
      </section>
      <NewKeyDialog open={open} limits={me.limits} onClosed={closed} />
    </div>
  );
}

/** "Check your mail to verify the address", with "Send again" (`POST /auth/resend`). */
export function VerifyBanner({ email }: { email: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<"idle" | "busy" | "sent" | string>("idle");
  const resend = async () => {
    setState("busy");
    try {
      await api("POST", "/auth/resend");
      setState("sent");
    } catch (error) {
      setState(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <Banner tone="info" testId="verify-banner">
      <span>{t("KEYS", "VERIFY_BANNER", { email })}</span>{" "}
      {state === "sent" ? (
        <strong data-testid="resent">{t("KEYS", "RESENT")}</strong>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={state === "busy"}
          onClick={resend}
          data-testid="resend"
        >
          {t("KEYS", "RESEND")}
        </Button>
      )}
      {state !== "idle" && state !== "busy" && state !== "sent" ? (
        <span className="field__error">{state}</span>
      ) : null}
    </Banner>
  );
}
