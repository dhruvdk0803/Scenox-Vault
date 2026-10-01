import * as React from 'react';
import { cn } from '@/lib/utils';

export const inputBase =
  'w-full rounded-md border border-border-strong bg-surface text-sm text-fg shadow-xs transition-colors duration-150 placeholder:text-fg-subtle hover:border-fg-subtle/60 focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring disabled:cursor-not-allowed disabled:bg-surface-muted disabled:opacity-60 aria-[invalid=true]:border-danger-solid aria-[invalid=true]:focus-visible:outline-danger-solid/40';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type = 'text', ...props }, ref) => (
    <input ref={ref} type={type} className={cn(inputBase, 'h-9 px-3', className)} {...props} />
  ),
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(inputBase, 'min-h-20 px-3 py-2', className)} {...props} />
  ),
);
Textarea.displayName = 'Textarea';
