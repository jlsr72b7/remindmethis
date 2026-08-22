import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useColorScheme } from 'react-native';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export interface ThemeColors {
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textPlaceholder: string;
  background: string;
  surface: string;
  surfaceSubtle: string;
  surfaceTint: string;
  border: string;
  borderStrong: string;
  borderTint: string;
  primary: string;
  primaryPressed: string;
  primarySoft: string;
  successText: string;
  successBg: string;
  successBorder: string;
  dangerText: string;
  dangerPressed: string;
  dangerBg: string;
  dangerBorder: string;
  warningText: string;
  warning: string;
  warningBg: string;
  accentTeal: string;
  shadow: string;
  overlay: string;
  // Text color for content drawn on top of a solid, saturated background that doesn't itself
  // change between themes (colored pills/buttons, EVENT_SUMMARY_COLORS chips, etc.) — always a
  // light color, unlike `surface`, which is intentionally white in light mode but flips dark in
  // dark mode and so isn't safe to use as "text on a colored button" once dark mode is on.
  onColor: string;
}

export const lightColors: ThemeColors = {
  textPrimary: '#0f172a',
  textSecondary: '#475569',
  textTertiary: '#64748b',
  textPlaceholder: '#94a3b8',
  background: '#f8fafc',
  surface: '#ffffff',
  surfaceSubtle: '#f1f5f9',
  surfaceTint: '#eff6ff',
  border: '#e2e8f0',
  borderStrong: '#cbd5e1',
  borderTint: '#bfdbfe',
  primary: '#2563eb',
  primaryPressed: '#1d4ed8',
  primarySoft: '#93c5fd',
  successText: '#15803d',
  successBg: '#dcfce7',
  successBorder: '#86efac',
  dangerText: '#dc2626',
  dangerPressed: '#b91c1c',
  dangerBg: '#fee2e2',
  dangerBorder: '#fca5a5',
  warningText: '#92400e',
  warning: '#f59e0b',
  warningBg: '#fef3c7',
  accentTeal: '#0f766e',
  shadow: '#0f172a',
  overlay: 'rgba(15, 23, 42, 0.35)',
  onColor: '#ffffff',
};

export const darkColors: ThemeColors = {
  textPrimary: '#f1f5f9',
  textSecondary: '#cbd5e1',
  textTertiary: '#94a3b8',
  textPlaceholder: '#64748b',
  background: '#0b1220',
  surface: '#111827',
  surfaceSubtle: '#1e293b',
  surfaceTint: '#152238',
  border: '#334155',
  borderStrong: '#475569',
  borderTint: '#3b5c8f',
  primary: '#3b82f6',
  primaryPressed: '#2563eb',
  primarySoft: '#60a5fa',
  successText: '#4ade80',
  successBg: '#14532d',
  successBorder: '#22c55e',
  dangerText: '#f87171',
  dangerPressed: '#dc2626',
  dangerBg: '#451a1a',
  dangerBorder: '#b91c1c',
  warningText: '#fbbf24',
  warning: '#f59e0b',
  warningBg: '#3f2d0a',
  accentTeal: '#14b8a6',
  shadow: '#000000',
  overlay: 'rgba(0, 0, 0, 0.6)',
  onColor: '#ffffff',
};

const THEME_MODE_STORAGE_KEY = 'app-theme-mode';

export const normalizeThemeMode = (raw: unknown): ThemeMode => (
  raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system'
);

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  resolvedTheme: ResolvedTheme;
  colors: ThemeColors;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('system');

  useEffect(() => {
    let isMounted = true;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(THEME_MODE_STORAGE_KEY);
        if (isMounted) {
          setModeState(normalizeThemeMode(raw));
        }
      } catch (error) {
        console.warn('Unable to load theme preference', error);
      }
    })();
    return () => {
      isMounted = false;
    };
  }, []);

  const setMode = (nextMode: ThemeMode) => {
    setModeState(nextMode);
    AsyncStorage.setItem(THEME_MODE_STORAGE_KEY, nextMode).catch((error) => {
      console.warn('Unable to save theme preference', error);
    });
  };

  const resolvedTheme: ResolvedTheme = mode === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : mode;
  const colors = resolvedTheme === 'dark' ? darkColors : lightColors;

  const value = useMemo<ThemeContextValue>(() => ({ mode, setMode, resolvedTheme, colors }), [mode, resolvedTheme, colors]);

  return React.createElement(ThemeContext.Provider, { value }, children);
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}
