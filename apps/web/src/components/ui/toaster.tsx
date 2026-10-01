'use client';

import { Toaster as Sonner } from 'sonner';

export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      closeButton
      toastOptions={{
        classNames: {
          toast: '!rounded-lg !border !border-border !bg-surface !text-fg !shadow-md !font-sans',
          description: '!text-fg-muted',
          closeButton: '!border-border !bg-surface !text-fg-subtle',
        },
      }}
    />
  );
}

export { toast } from 'sonner';
