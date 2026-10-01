import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const track = cva('relative w-full overflow-hidden rounded-full bg-surface-muted', {
  variants: { size: { sm: 'h-1', md: 'h-2', lg: 'h-3' } },
  defaultVariants: { size: 'md' },
});

const TONES = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger-solid',
  info: 'bg-info',
  neutral: 'bg-fg-subtle',
} as const;

export interface ProgressBarProps extends VariantProps<typeof track> {
  /** 0–100. Omit (or pass null) for indeterminate. */
  value?: number | null;
  tone?: keyof typeof TONES;
  label: string;
  className?: string;
}

export function ProgressBar({ value, tone = 'primary', size, label, className }: ProgressBarProps) {
  const determinate = value != null && Number.isFinite(value);
  const pct = determinate ? Math.max(0, Math.min(100, value)) : 0;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={determinate ? Math.round(pct) : undefined}
      className={cn(track({ size }), className)}
    >
      {determinate ? (
        <div className={cn('h-full rounded-full transition-[width] duration-300 ease-out', TONES[tone])} style={{ width: `${pct}%` }} />
      ) : (
        <div className={cn('absolute inset-y-0 w-2/5 rounded-full animate-indeterminate', TONES[tone])} />
      )}
    </div>
  );
}
