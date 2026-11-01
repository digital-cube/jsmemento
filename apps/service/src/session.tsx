import { UdcError } from "@jsudc/core";
import { Spinner } from "@jsudc/react/ui";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useEffect } from "react";
import { Navigate, useLocation } from "react-router";
import { ApiError, api } from "./lib/api.js";

/** The signed-in user, as `GET /auth/me` answers. */
export interface User {
  id: string;
  email: string;
  name: string;
  locale: string;
  email_verified: boolean;
  is_admin: boolean;
  created_at: string;
}

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  plan: string;
  /** `null`: the server's default (`limits.default_max_keys`). */
  max_keys: number | null;
  retention_days: number | null;
}

export interface Limits {
  default_max_keys: number;
  default_daily_limit: number;
  /** The ceiling of a key's daily limit; `null`: none. */
  max_daily_limit: number | null;
}

export interface Me {
  user: User;
  tenant: Tenant;
  limits: Limits;
}

/** The query of `GET /auth/me`; `null` data: nobody is signed in. */
export const ME_KEY = ["memento", "me"] as const;

export async function fetchMe(): Promise<Me | null> {
  try {
    return await api<Me>("GET", "/auth/me");
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

/** Who is signed in: `undefined` while asking, `null` for nobody. */
export function useMe(): { me: Me | null | undefined; error: Error | null } {
  const query = useQuery({ queryKey: ME_KEY, queryFn: fetchMe, staleTime: 60_000, retry: 1 });
  return { me: query.data, error: query.error };
}

/**
 * The user `<RequireSession>` let in. From context, not from the query: when the session ends
 * the page may render once more before the guard redirects, and must not find nobody.
 */
const SignedIn = createContext<Me | null>(null);

/** `me`, for a page under `<RequireSession>`. */
export function useSignedIn(): Me {
  const me = useContext(SignedIn);
  if (!me) throw new Error("useSignedIn outside <RequireSession>");
  return me;
}

/** The tenant's key ceiling: its own `max_keys`, else the server's default. */
export function maxKeysOf(me: Me): number {
  return me.tenant.max_keys ?? me.limits.default_max_keys;
}

/**
 * A refused call may mean the session is gone (expired, signed out elsewhere, the user
 * disabled): a UDC `forbidden` or an API 401 asks `/auth/me` again; when that answers 401 too,
 * `<RequireSession>` sends the visitor to `/login?next=…`.
 */
export function isSessionRefusal(error: unknown): boolean {
  return (
    (error instanceof UdcError && error.code === "forbidden") ||
    (error instanceof ApiError && error.status === 401)
  );
}

/** Watches every query and mutation of `queryClient` for `isSessionRefusal`. */
export function watchSession(queryClient: QueryClient): () => void {
  const recheck = (error: unknown) => {
    if (isSessionRefusal(error)) void queryClient.invalidateQueries({ queryKey: ME_KEY });
  };
  const offQueries = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "error") return;
    // `/auth/me` itself answers `null` for 401; anything else it throws is not a refusal.
    if (event.query.queryKey[0] === ME_KEY[0] && event.query.queryKey[1] === ME_KEY[1]) return;
    recheck(event.action.error);
  });
  const offMutations = queryClient.getMutationCache().subscribe((event) => {
    if (event.type === "updated" && event.action.type === "error") recheck(event.action.error);
  });
  return () => {
    offQueries();
    offMutations();
  };
}

/** Installs `watchSession` on the app's query client. */
export function SessionWatch() {
  const queryClient = useQueryClient();
  useEffect(() => watchSession(queryClient), [queryClient]);
  return null;
}

/** `next` when it is a path of this site, else `/keys`: never an open redirect. */
export function safeNext(next: string | null): string {
  return next?.startsWith("/") && !next.startsWith("//") ? next : "/keys";
}

/** `/login?next=<where the visitor wanted to go>`. */
export function loginPath(location: { pathname: string; search: string }): string {
  return `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
}

/** Its children for a signed-in user; anybody else goes to `/login?next=…`. */
export function RequireSession({
  admin = false,
  children,
}: {
  /** Only an administrator; a signed-in user who is not one goes to `/keys`. */
  admin?: boolean;
  children: ReactNode;
}) {
  const { me, error } = useMe();
  const location = useLocation();
  if (me === undefined) {
    return (
      <div className="page__center" data-testid="session-loading">
        {error ? <p role="alert">{error.message}</p> : <Spinner />}
      </div>
    );
  }
  if (me === null) return <Navigate to={loginPath(location)} replace />;
  if (admin && !me.user.is_admin) return <Navigate to="/keys" replace />;
  return <SignedIn.Provider value={me}>{children}</SignedIn.Provider>;
}
