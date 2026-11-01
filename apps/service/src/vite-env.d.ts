/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The memento API under this origin. Default `/memento`. */
  readonly VITE_MEMENTO_BASE_URL?: string;
}
