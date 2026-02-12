export {};

declare global {
  interface Window {
    opencorpo?: {
      chat: (
        messages: Array<{ role: "user" | "assistant" | "system"; content: string }>
      ) => Promise<{ text: string; error?: string }>;
      daemon: {
        getStatus: () => Promise<{
          running: boolean;
          ready: boolean;
          pid: number | null;
          port: number;
          apiBase: string;
          hasToken: boolean;
          lastError: string | null;
        }>;
        restart: () => Promise<{
          running: boolean;
          ready: boolean;
          pid: number | null;
          port: number;
          apiBase: string;
          hasToken: boolean;
          lastError: string | null;
        }>;
        getRuntimeConfig: () => Promise<{ apiBase: string; launchToken: string }>;
        openRuntimeFolder: () => Promise<string>;
      };
    };
  }
}
