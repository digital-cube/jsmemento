/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MEMENTO_API_KEY?: string;
  readonly VITE_MEMENTO_BASE_URL?: string;
  /** The UDC collection the sidebar is drawn from. Default `menu`. */
  readonly VITE_MENU_COLLECTION?: string;
}
