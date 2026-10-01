import { cn } from '@/lib/utils';

export function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn('inline-flex h-5 min-w-5 items-center justify-center rounded border border-border-strong bg-surface-muted px-1 font-sans text-[11px] font-medium text-fg-subtle', className)}
      {...props}
    />
  );
}
