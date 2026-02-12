export const designTokens = {
  radius: {
    sm: "0.5rem",
    md: "0.75rem",
    lg: "1rem",
    xl: "1.25rem"
  },
  color: {
    text: "#0f172a",
    muted: "#64748b",
    border: "#e2e8f0",
    panel: "#ffffff",
    success: "#059669",
    warning: "#d97706",
    danger: "#dc2626"
  },
  space: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24
  }
} as const;

export type DesignTokens = typeof designTokens;
