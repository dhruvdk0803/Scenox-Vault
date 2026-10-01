'use client';

import * as React from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { inputBase } from './input';
import { Kbd } from './kbd';

export interface SearchInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'defaultValue'> {
  /** Called with the trimmed value after `debounceMs` of inactivity (and immediately on clear). */
  onChange: (value: string) => void;
  defaultValue?: string;
  debounceMs?: number;
  /** Show a ⌘K hint (display only; wire the shortcut yourself). */
  shortcutHint?: boolean;
}

export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  ({ onChange, defaultValue = '', debounceMs = 300, shortcutHint, className, placeholder = 'Search…', 'aria-label': ariaLabel = 'Search', ...props }, ref) => {
    const [value, setValue] = React.useState(defaultValue);
    const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
    const onChangeRef = React.useRef(onChange);
    onChangeRef.current = onChange;
    React.useEffect(() => () => clearTimeout(timer.current), []);

    function update(next: string, immediate = false) {
      setValue(next);
      clearTimeout(timer.current);
      if (immediate) onChangeRef.current(next.trim());
      else timer.current = setTimeout(() => onChangeRef.current(next.trim()), debounceMs);
    }

    return (
      <div className={cn('relative w-full', className)}>
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" aria-hidden />
        <input
          ref={ref}
          type="search"
          role="searchbox"
          value={value}
          onChange={(e) => update(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && value) {
              e.preventDefault();
              update('', true);
            }
          }}
          placeholder={placeholder}
          aria-label={ariaLabel}
          className={cn(inputBase, 'h-9 pl-9 pr-9 [&::-webkit-search-cancel-button]:hidden')}
          {...props}
        />
        {value ? (
          <button
            type="button"
            onClick={() => update('', true)}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-fg-subtle transition-colors hover:bg-surface-muted hover:text-fg"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        ) : (
          shortcutHint && (
            <span className="pointer-events-none absolute right-2.5 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 sm:flex" aria-hidden>
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
            </span>
          )
        )}
      </div>
    );
  },
);
SearchInput.displayName = 'SearchInput';
