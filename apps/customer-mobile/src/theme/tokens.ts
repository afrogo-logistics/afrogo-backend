// apps/customer-mobile/src/design/tokens.ts
// Design tokens – single source of truth for the AfroGo customer app

export const tokens = {
  colors: {
    bgStart: '#071228',
    bgEnd: '#2D0F2A',
    accentRed: '#E0312A',
    glassTint: 'rgba(255,255,255,0.06)',
    glassBorder: 'rgba(255,255,255,0.08)',
    textPrimary: '#F5F7FA',
    textSecondary: '#B8C1CC',
    textOnAccent: '#FFFFFF',          // For text on red buttons/chips
    iconMuted: '#9AA3B2',
    mapLine: '#C62828',
    mapPinStart: '#0D3B66',
    error: '#FF5C5C',
    divider: 'rgba(255,255,255,0.04)',
  },

  spacing: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
    xxl: 48,
  },

  // Border radii
  radius: {
    sm: 8,
    md: 16,
    lg: 24,
    pill: 999,
  },

  typography: {
    // React Native expects a single registered font family name
    fontFamily: 'Inter',
    // Optional: use this in your theme layer if you want a platform default
    fallbackFontFamily: 'System',

    h1: 28,
    h2: 20,
    body: 16,
    small: 12,
  },

  shadows: {
    // Use as shadowColor + low elevation/opacity for subtle glow
    navGlow: 'rgba(224,49,42,0.14)',
  },
} as const;

export type Tokens = typeof tokens;
