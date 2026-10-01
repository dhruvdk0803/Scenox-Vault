'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Branding } from '@scenox/shared';
import { api } from '@/lib/api';
import { HEX_RE, readableTextColor } from '@/lib/color';
import { queryKeys } from '@/lib/query-keys';

/** Fetches public branding and applies the primary colour (+ readable foreground) to the document root. */
export function BrandingProvider({ children }: { children?: React.ReactNode }) {
  const { data } = useQuery({
    queryKey: queryKeys.branding,
    queryFn: ({ signal }) => api.get<Branding>('/public/branding', { signal, redirectOn401: false }),
    staleTime: 5 * 60_000,
    retry: false,
  });

  React.useEffect(() => {
    const color = data?.primaryColor;
    if (!color || !HEX_RE.test(color)) return;
    const root = document.documentElement;
    root.style.setProperty('--primary', color);
    root.style.setProperty('--primary-foreground', readableTextColor(color));
    return () => {
      root.style.removeProperty('--primary');
      root.style.removeProperty('--primary-foreground');
    };
  }, [data?.primaryColor]);

  return <>{children}</>;
}
