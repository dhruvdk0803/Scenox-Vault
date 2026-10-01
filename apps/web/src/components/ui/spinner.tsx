import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span role="status" className="inline-flex">
      <Loader2 className={cn('size-4 animate-spin text-current', className)} aria-hidden />
      <span className="sr-only">{label ?? 'Loading'}</span>
    </span>
  );
}
