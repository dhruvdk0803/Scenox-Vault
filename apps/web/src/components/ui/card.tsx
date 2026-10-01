import * as React from 'react';
import { cn } from '@/lib/utils';

type DivProps = React.HTMLAttributes<HTMLDivElement>;

export const Card = React.forwardRef<HTMLDivElement, DivProps>(({ className, ...props }, ref) => (
  <div ref={ref} className={cn('rounded-lg border border-border bg-surface text-fg shadow-xs', className)} {...props} />
));
Card.displayName = 'Card';

export const CardHeader = ({ className, ...props }: DivProps) => (
  <div className={cn('flex flex-col gap-1 p-5 pb-0', className)} {...props} />
);

export const CardTitle = ({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
  <h3 className={cn('text-base font-semibold tracking-tight text-fg', className)} {...props} />
);

export const CardDescription = ({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn('text-sm text-fg-muted', className)} {...props} />
);

export const CardContent = ({ className, ...props }: DivProps) => <div className={cn('p-5', className)} {...props} />;

export const CardFooter = ({ className, ...props }: DivProps) => (
  <div className={cn('flex items-center gap-2 border-t border-border px-5 py-3', className)} {...props} />
);
