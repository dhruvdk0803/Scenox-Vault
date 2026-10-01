'use client';

import { Info } from 'lucide-react';
import { Card } from '@/components/ui';
import type { Portal } from './portal-context';

/** The agency's description and instructions for this portal. */
export function PortalNotes({ portal, only }: { portal: Portal; only?: 'instructions' }) {
  const showDescription = !!portal.description && only !== 'instructions';
  if (!showDescription && !portal.instructions) return null;
  return (
    <Card className="flex flex-col gap-4 p-5">
      {showDescription && <p className="whitespace-pre-line text-sm text-fg-muted sm:text-base">{portal.description}</p>}
      {portal.instructions && (
        <div className="flex gap-3 rounded-lg border border-primary-soft-border bg-primary-soft p-4 text-sm text-primary-soft-fg">
          <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
          <div className="flex flex-col gap-1">
            <p className="font-medium">Instructions</p>
            <p className="whitespace-pre-line">{portal.instructions}</p>
          </div>
        </div>
      )}
    </Card>
  );
}
