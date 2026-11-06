/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Override endpoint RPC devnet (mis. Helius/QuickNode) agar tidak kena rate-limit. */
  readonly VITE_RPC_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
