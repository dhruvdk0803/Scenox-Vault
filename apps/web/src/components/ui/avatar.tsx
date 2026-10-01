import { cva, type VariantProps } from 'class-variance-authority';
import { cn, initials } from '@/lib/utils';

const avatar = cva('inline-flex shrink-0 select-none items-center justify-center rounded-full bg-primary-soft font-semibold text-primary-soft-fg ring-1 ring-primary-soft-border', {
  variants: { size: { sm: 'size-6 text-[10px]', md: 'size-8 text-xs', lg: 'size-10 text-sm' } },
  defaultVariants: { size: 'md' },
});

export function Avatar({ name, size, className }: { name: string; className?: string } & VariantProps<typeof avatar>) {
  return (
    <span className={cn(avatar({ size }), className)} aria-hidden>
      {initials(name)}
    </span>
  );
}
