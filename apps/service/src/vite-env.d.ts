/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The memento API under this origin. Default `/memento`. */
  readonly VITE_MEMENTO_BASE_URL?: string;
}

/** The client programs of `clients/`, read at build time by vite-plugin-clients.ts. */
declare module "virtual:clients" {
  const clients: import("./pages/clients/types.js").ClientProgram[];
  export default clients;
}
