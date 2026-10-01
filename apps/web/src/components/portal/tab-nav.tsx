'use client';

import * as React from 'react';
import { FolderOpen, History, LayoutDashboard, MessageSquare, UploadCloud, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TAB_LABELS, type PortalTab } from '@/lib/portal/tabs';

const ICONS: Record<PortalTab, LucideIcon> = {
  overview: LayoutDashboard,
  upload: UploadCloud,
  files: FolderOpen,
  uploads: History,
  messages: MessageSquare,
};

export const tabId = (variant: string, t: PortalTab) => `portal-tab-${variant}-${t}`;
export const panelId = (t: PortalTab) => `portal-panel-${t}`;

export function UnreadBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span className={cn('inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold leading-5 text-primary-foreground tabular-nums', className)}>
      {count > 99 ? '99+' : count}
      <span className="sr-only"> unread {count === 1 ? 'message' : 'messages'}</span>
    </span>
  );
}

/**
 * Accessible tab strip (role=tablist). `top` is the horizontal desktop nav, `bottom` the fixed phone bar.
 * Arrow keys / Home / End move focus; Enter or Space selects.
 */
export function TabNav({
  tabs, active, onSelect, unread, variant,
}: {
  tabs: readonly PortalTab[];
  active: PortalTab;
  onSelect: (t: PortalTab) => void;
  unread: number;
  variant: 'top' | 'bottom';
}) {
  const refs = React.useRef(new Map<PortalTab, HTMLButtonElement>());

  function onKeyDown(e: React.KeyboardEvent) {
    const i = tabs.indexOf(active);
    const focused = tabs.findIndex((t) => refs.current.get(t) === document.activeElement);
    const cur = focused >= 0 ? focused : i;
    let next = -1;
    if (e.key === 'ArrowRight') next = (cur + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (cur - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    refs.current.get(tabs[next]!)?.focus();
  }

  const list = (
    <div
      role="tablist" aria-label="Portal sections" onKeyDown={onKeyDown}
      className={cn(variant === 'top' ? 'flex items-center gap-1 overflow-x-auto' : 'grid h-14 items-stretch')}
      style={variant === 'bottom' ? { gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` } : undefined}
    >
      {tabs.map((t) => {
        const Icon = ICONS[t];
        const selected = t === active;
        const showUnread = t === 'messages' ? unread : 0;
        return (
          <button
            key={t}
            ref={(el) => {
              if (el) refs.current.set(t, el);
              else refs.current.delete(t);
            }}
            type="button" role="tab" id={tabId(variant, t)} aria-selected={selected} aria-controls={panelId(t)} tabIndex={selected ? 0 : -1}
            onClick={() => onSelect(t)}
            className={
              variant === 'top'
                ? cn(
                    'relative -mb-px inline-flex h-11 shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
                    selected ? 'border-primary text-fg' : 'border-transparent text-fg-muted hover:text-fg',
                  )
                : cn(
                    'relative flex flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-ring',
                    selected ? 'text-primary' : 'text-fg-subtle',
                  )
            }
          >
            {variant === 'bottom' && selected && <span aria-hidden className="absolute inset-x-6 top-0 h-0.5 rounded-b-full bg-primary" />}
            <span className="relative inline-flex">
              <Icon aria-hidden className={variant === 'top' ? 'size-4' : 'size-5'} strokeWidth={selected && variant === 'bottom' ? 2.25 : 2} />
              {variant === 'bottom' && showUnread > 0 && <UnreadBadge count={showUnread} className="absolute -right-3 -top-2 min-w-4 px-1 text-[10px] leading-4" />}
            </span>
            {TAB_LABELS[t]}
            {variant === 'top' && showUnread > 0 && <UnreadBadge count={showUnread} className="ml-0.5" />}
          </button>
        );
      })}
    </div>
  );

  if (variant === 'top') return list;
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-1px_8px_rgb(0_0_0/0.04)] backdrop-blur md:hidden">
      {list}
    </div>
  );
}
