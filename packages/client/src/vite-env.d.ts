/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Enable service worker in dev mode (default: false) */
  readonly VITE_ENABLE_SW?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Build-time version from git describe (injected by Vite define) */
declare const __APP_VERSION__: string;

/** Wall-clock build timestamp (ISO 8601), injected by Vite define */
declare const __BUILD_DATE__: string;

/** Build profile: "debug" | "release" (APK) or "dev" (web), injected by Vite define */
declare const __BUILD_PROFILE__: string;
