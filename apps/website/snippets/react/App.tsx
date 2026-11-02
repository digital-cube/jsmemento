import { MementoDataView, MementoProvider } from "@memento/react";
import "@memento/react/styles.css";

// A live table of the tenant's user events, rendered in Serbian. `/memento` is your own
// origin (proxied to memento); the key needs the read scope.
export function App({ apiKey }: { apiKey: string }) {
  return (
    <MementoProvider baseUrl="/memento" apiKey={apiKey} locale="sr">
      <MementoDataView title="Users" initialFilter={{ instance_type: "user" }} />
    </MementoProvider>
  );
}
