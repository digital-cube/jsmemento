import type { UdcClient } from "@jsudc/core/client";
import {
  createRendererRegistry,
  createUdcQueryClient,
  type Locale,
  UdcI18nProvider,
  UdcProvider,
  udcKeys,
} from "@jsudc/react";
import { chartRenderer } from "@jsudc/react/chart";
import { UdcReactRouterUrlState } from "@jsudc/react/react-router";
import { tableRenderer } from "@jsudc/react/table";
import { Toaster, TooltipProvider } from "@jsudc/react/ui";
import { routerBasename, storedLocale, storeLocale } from "@memento/ui-shell";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AccountPage } from "./account/Account.js";
import { AdminUserPage } from "./admin/AdminUser.js";
import { AdminUsersPage } from "./admin/AdminUsers.js";
import { SERVICE_MESSAGES } from "./i18n/messages.js";
import { KeyPage } from "./keys/KeyPage.js";
import { KeysPage } from "./keys/KeysPage.js";
import { serviceUdcClient } from "./lib/udc.js";
import { ClientsPage } from "./pages/Clients.js";
import { ForgotPage, LoginPage, ResetPage } from "./pages/Login.js";
import { HomePage, TermsPage } from "./pages/Public.js";
import { RegisterPage } from "./pages/Register.js";
import { VerifyPage } from "./pages/Verify.js";
import { RequireSession, SessionWatch } from "./session.js";
import { ServiceShell } from "./shell/ServiceShell.js";

// Module constant: the registry must not change between renders.
const renderers = createRendererRegistry(tableRenderer, chartRenderer);

/**
 * Query cache, UDC client (the cookie, no token), language and the session watch: what every
 * page needs, without the router (tests wrap a `MemoryRouter` around it).
 */
export function ServiceProviders({
  locale,
  onLocaleChange,
  queryClient,
  client,
  children,
}: {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  queryClient: QueryClient;
  client: UdcClient;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <UdcI18nProvider messages={SERVICE_MESSAGES} locale={locale} onLocaleChange={onLocaleChange}>
        <UdcProvider client={client} renderers={renderers}>
          <TooltipProvider>
            <Toaster>
              <SessionWatch />
              {children}
            </Toaster>
          </TooltipProvider>
        </UdcProvider>
      </UdcI18nProvider>
    </QueryClientProvider>
  );
}

/** The routes of the site, under `<ServiceShell>`. */
export function ServiceRoutes() {
  return (
    <Routes>
      <Route element={<ServiceShell />}>
        <Route index element={<HomePage />} />
        <Route path="register" element={<RegisterPage />} />
        <Route path="login" element={<LoginPage />} />
        <Route path="forgot" element={<ForgotPage />} />
        <Route path="reset/:token" element={<ResetPage />} />
        <Route path="verify/:token" element={<VerifyPage />} />
        <Route path="terms" element={<TermsPage />} />
        <Route path="keys" element={signedIn(<KeysPage />)} />
        <Route path="keys/:id" element={signedIn(<KeyPage />)} />
        <Route path="keys/:id/:tab" element={signedIn(<KeyPage />)} />
        <Route path="clients" element={signedIn(<ClientsPage />)} />
        <Route path="account" element={signedIn(<AccountPage />)} />
        <Route path="admin" element={<Navigate to="/admin/users" replace />} />
        <Route path="admin/users" element={signedIn(<AdminUsersPage />, true)} />
        <Route path="admin/users/:id" element={signedIn(<AdminUserPage />, true)} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

function signedIn(page: ReactNode, admin = false) {
  return <RequireSession admin={admin}>{page}</RequireSession>;
}

export function App() {
  // The header's language: the strings of the site and the `rendered` text of every row.
  const [locale, setLocale] = useState<Locale>(storedLocale);
  const changeLocale = useCallback((next: Locale) => {
    storeLocale(next);
    setLocale(next);
  }, []);
  const client = useMemo(() => serviceUdcClient(locale), [locale]);
  const [queryClient] = useState(createUdcQueryClient);
  // Another language: every list is fetched again, so the rows' `rendered` text comes back in it.
  const shownLocale = useRef(locale);
  useEffect(() => {
    if (shownLocale.current === locale) return;
    shownLocale.current = locale;
    void queryClient.invalidateQueries({ queryKey: [...udcKeys.all, "list"] });
  }, [locale, queryClient]);
  const [basename] = useState(() => routerBasename(location.pathname));

  return (
    <ServiceProviders
      locale={locale}
      onLocaleChange={changeLocale}
      queryClient={queryClient}
      client={client}
    >
      <BrowserRouter basename={basename}>
        <UdcReactRouterUrlState>
          <ServiceRoutes />
        </UdcReactRouterUrlState>
      </BrowserRouter>
    </ServiceProviders>
  );
}
