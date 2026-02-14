export type PluginSummary = {
  name: string;
  version: string;
  loaded: boolean;
  error?: string | null;
};
