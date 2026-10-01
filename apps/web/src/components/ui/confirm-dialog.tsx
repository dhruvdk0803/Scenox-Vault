'use client';

import * as React from 'react';
import { Button } from './button';
import { Input } from './input';
import { Label } from './label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './dialog';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  /** Async handler; dialog shows loading and closes on success. Throw to keep it open. */
  onConfirm: () => void | Promise<void>;
  /** If set, the user must type this exact text to enable the confirm button. */
  requireText?: string;
}

export function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel = 'Confirm', cancelLabel = 'Cancel', destructive, onConfirm, requireText,
}: ConfirmDialogProps) {
  const [loading, setLoading] = React.useState(false);
  const [typed, setTyped] = React.useState('');
  const inputId = React.useId();

  React.useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  const canConfirm = !requireText || typed === requireText;

  async function handleConfirm() {
    setLoading(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // Caller surfaces the error (toast); keep the dialog open.
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !loading && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {requireText && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={inputId}>
              Type <span className="rounded bg-surface-muted px-1 font-mono text-xs">{requireText}</span> to confirm
            </Label>
            <Input id={inputId} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} onClick={handleConfirm} loading={loading} disabled={!canConfirm}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
