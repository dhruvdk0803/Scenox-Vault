'use client';

import { toast } from '@/components/ui/toaster';
import { errorMessage } from '@/lib/api';

/**
 * Wraps an async action: success toast on resolve, friendly error toast on reject (then rethrows so ConfirmDialog stays open).
 */
export function withToast<A extends unknown[], R>(fn: (...args: A) => Promise<R>, messages: { success?: string | ((r: R) => string); error?: string }) {
  return async (...args: A): Promise<R> => {
    try {
      const r = await fn(...args);
      if (messages.success) toast.success(typeof messages.success === 'function' ? messages.success(r) : messages.success);
      return r;
    } catch (err) {
      toast.error(messages.error ?? 'Action failed', { description: errorMessage(err) });
      throw err;
    }
  };
}
