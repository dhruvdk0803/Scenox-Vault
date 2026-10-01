import * as React from 'react';
import { cn } from '@/lib/utils';

/** Container for search + filters above a table. Wraps on small screens. */
export function FilterBar({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div role="search" className={cn('mb-4 flex flex-wrap items-center gap-2 [&>[data-grow]]:min-w-48 [&>[data-grow]]:flex-1', className)} {...props}>
      {children}
    </div>
  );
}
