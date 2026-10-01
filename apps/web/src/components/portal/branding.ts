import type * as React from 'react';
import type { PortalUnlockResponse } from '@scenox/shared';

/** Black or white, whichever is more readable on the given #rrggbb background (WCAG relative luminance). */
export function readableTextColor(hex: string): '#ffffff' | '#18181b' {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#ffffff';
  const n = parseInt(m[1]!, 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.4 ? '#18181b' : '#ffffff';
}

export function isHexColor(v: string | null | undefined): v is string {
  return !!v && /^#[0-9a-f]{6}$/i.test(v.trim());
}

/**
 * Inline style that re-themes a subtree. The derived tokens (hover/soft/ring) are re-declared because custom
 * properties computed on :root would otherwise keep the default brand colour inside the wrapper.
 */
export function brandStyle(primary: string | null | undefined): React.CSSProperties {
  if (!isHexColor(primary)) return {};
  return {
    '--primary': primary,
    '--primary-foreground': readableTextColor(primary),
    '--primary-hover': 'color-mix(in oklab, var(--primary) 88%, black)',
    '--primary-soft': 'color-mix(in oklab, var(--primary) 8%, white)',
    '--primary-soft-border': 'color-mix(in oklab, var(--primary) 22%, white)',
    '--primary-soft-fg': 'color-mix(in oklab, var(--primary) 85%, black)',
    '--ring': 'color-mix(in oklab, var(--primary) 70%, white)',
  } as React.CSSProperties;
}

/* ───────── small browser-storage helpers (all failure-tolerant) ───────── */

const ACCESS_KEY = (t: string) => `sv:portal-access:${t}`;
const INTAKE_KEY = (t: string) => `sv:portal-intake:${t}`;
const IDENTITY_KEY = (t: string) => `sv:portal-identity:${t}`;

function read<T>(storage: 'local' | 'session', key: string): T | null {
  try {
    const s = storage === 'local' ? window.localStorage : window.sessionStorage;
    const raw = s.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
function write(storage: 'local' | 'session', key: string, value: unknown) {
  try {
    (storage === 'local' ? window.localStorage : window.sessionStorage).setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}
function remove(storage: 'local' | 'session', key: string) {
  try {
    (storage === 'local' ? window.localStorage : window.sessionStorage).removeItem(key);
  } catch {
    /* ignore */
  }
}

export const accessStore = {
  load(token: string): PortalUnlockResponse | null {
    const v = read<PortalUnlockResponse>('local', ACCESS_KEY(token));
    if (!v?.accessToken) return null;
    if (v.expiresAt && Date.parse(v.expiresAt) <= Date.now()) {
      remove('local', ACCESS_KEY(token));
      return null;
    }
    return v;
  },
  save: (token: string, v: PortalUnlockResponse) => write('local', ACCESS_KEY(token), v),
  clear: (token: string) => remove('local', ACCESS_KEY(token)),
};

export interface IntakeValues {
  name: string;
  email: string;
  company: string;
  message: string;
}
export const EMPTY_INTAKE: IntakeValues = { name: '', email: '', company: '', message: '' };

export const intakeStore = {
  load: (token: string) => read<IntakeValues>('session', INTAKE_KEY(token)),
  save: (token: string, v: IntakeValues) => write('session', INTAKE_KEY(token), v),
};

/** Who the client is when writing messages; remembered per portal on this device. */
export interface Identity {
  name: string;
  email: string;
}
export const identityStore = {
  load: (token: string) => read<Identity>('local', IDENTITY_KEY(token)),
  save: (token: string, v: Identity) => write('local', IDENTITY_KEY(token), v),
};

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
