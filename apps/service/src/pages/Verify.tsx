import { useI18n } from "@jsudc/react";
import { Spinner } from "@jsudc/react/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, useParams } from "react-router";
import { ApiError, api, errorText } from "../lib/api.js";
import { AuthCard, Banner } from "../lib/ui.js";
import { ME_KEY, type User } from "../session.js";

/**
 * `/verify/:token`: verifies on load (once per token — a query, so StrictMode's second mount
 * does not spend the token twice), shows the result, links to `/keys`.
 */
export function VerifyPage() {
  const { t } = useI18n();
  const { token = "" } = useParams();
  const queryClient = useQueryClient();
  const verify = useQuery({
    queryKey: ["memento", "verify", token],
    queryFn: () => api<{ user: User }>("POST", "/auth/verify", { token }),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
  const verified = verify.isSuccess;
  useEffect(() => {
    if (verified) void queryClient.invalidateQueries({ queryKey: ME_KEY });
  }, [verified, queryClient]);

  return (
    <AuthCard title={t("AUTH", "VERIFY_TITLE")} testId="verify">
      {verify.isPending ? (
        <p>
          <Spinner /> {t("AUTH", "VERIFYING")}
        </p>
      ) : verify.data ? (
        <Banner tone="ok" testId="verify-ok">
          {t("AUTH", "VERIFIED", { email: verify.data.user.email })}
        </Banner>
      ) : (
        <Banner tone="bad" testId="verify-failed">
          {t("AUTH", "VERIFY_FAILED", {
            message:
              verify.error instanceof ApiError ? errorText(verify.error) : String(verify.error),
          })}
        </Banner>
      )}
      <Link className="btn btn--primary" to="/keys">
        {t("AUTH", "TO_KEYS")}
      </Link>
    </AuthCard>
  );
}
