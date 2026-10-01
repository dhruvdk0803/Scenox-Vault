'use client';

import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { Button, type ButtonProps } from './button';
import { Tooltip } from './tooltip';

export interface CopyButtonProps extends Omit<ButtonProps, 'onClick' | 'children' | 'asChild'> {
  value: string;
  /** Accessible name, e.g. "Copy upload link". */
  label?: string;
  /** Show the label text next to the icon. */
  showLabel?: boolean;
}

export function CopyButton({ value, label = 'Copy', showLabel = false, variant = 'ghost', size, ...props }: CopyButtonProps) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1800);
  }

  const btn = (
    <Button variant={variant} size={size ?? (showLabel ? 'sm' : 'icon')} onClick={copy} aria-label={showLabel ? undefined : copied ? 'Copied' : label} {...props}>
      {copied ? <Check className="text-success" aria-hidden /> : <Copy aria-hidden />}
      {showLabel && (copied ? 'Copied' : label)}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied to clipboard' : ''}
      </span>
    </Button>
  );
  return showLabel ? btn : <Tooltip content={copied ? 'Copied' : label}>{btn}</Tooltip>;
}
