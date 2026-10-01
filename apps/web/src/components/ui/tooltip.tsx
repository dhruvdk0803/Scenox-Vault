'use client';

import * as React from 'react';
import { Tooltip as Primitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export const TooltipProvider = ({ delayDuration = 300, ...props }: React.ComponentProps<typeof Primitive.Provider>) => (
  <Primitive.Provider delayDuration={delayDuration} {...props} />
);

/** <Tooltip content="Copy link"><Button size="icon" aria-label="Copy link">…</Button></Tooltip> */
export function Tooltip({
  content, children, side = 'top', className,
}: {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
}) {
  return (
    <Primitive.Root>
      <Primitive.Trigger asChild>{children}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          side={side}
          sideOffset={6}
          className={cn('z-50 max-w-xs rounded-md bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-white shadow-md animate-fade-in', className)}
        >
          {content}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
