import { cn } from '@/lib/utils';

/** Rounded-square vault mark: a door with a dial. Uses the runtime brand color. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-8', className)} fill="none" aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--primary)" />
      <rect x="7" y="7" width="18" height="18" rx="4.5" stroke="var(--primary-foreground)" strokeOpacity="0.55" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="4" stroke="var(--primary-foreground)" strokeWidth="1.75" />
      <path d="M16 12v-2M16 22v-2M12 16h-2M22 16h-2" stroke="var(--primary-foreground)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ className, markClassName, showWordmark = true }: { className?: string; markClassName?: string; showWordmark?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark className={markClassName} />
      {showWordmark ? (
        <span className="text-[15px] font-semibold tracking-tight text-fg">
          Scenox <span className="text-fg-muted">Vault</span>
        </span>
      ) : (
        <span className="sr-only">Scenox Vault</span>
      )}
    </span>
  );
}
