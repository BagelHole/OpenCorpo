/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OC_API_BASE?: string;
  readonly VITE_OC_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
