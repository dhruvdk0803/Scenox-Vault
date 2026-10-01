'use client';

import * as React from 'react';
import { AlertTriangle, Copy } from 'lucide-react';
import { formatBytes, formatNumber, type PreflightResult } from '@scenox/shared';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui';
import { cn } from '@/lib/utils';

export type DuplicateChoice = 'replace' | 'keep_both' | 'skip';

export interface PreflightPlan {
  accepted: number;
  acceptedBytes: number;
  rejected: { name: string; relativePath: string; reason: string }[];
  duplicates: number;
  duplicateBytes: number;
}

export function reasonText(r: Pick<PreflightResult, 'reason' | 'message'>, maxFileSize?: number | null): string {
  switch (r.reason) {
    case 'blocked_type': return 'This file type isn’t allowed for security reasons';
    case 'not_allowed_type': return 'This file type isn’t accepted by this link';
    case 'too_large': return maxFileSize ? `Larger than the ${formatBytes(maxFileSize)} limit` : 'File is too large';
    case 'quota_exceeded': return 'Not enough space left on this link';
    case 'zip_not_allowed': return 'Zip files aren’t accepted by this link';
    case 'folders_not_allowed': return 'Folders aren’t accepted by this link';
    default: return r.message ?? 'This file can’t be uploaded';
  }
}

const OPTIONS: { value: DuplicateChoice; title: string; hint: string }[] = [
  { value: 'replace', title: 'Replace', hint: 'Overwrite the files that are already there.' },
  { value: 'keep_both', title: 'Keep both', hint: 'Upload as new copies, e.g. “report (1).pdf”.' },
  { value: 'skip', title: 'Skip', hint: 'Don’t upload files that already exist.' },
];

export function PreflightDialog({ plan, onConfirm, onCancel }: { plan: PreflightPlan | null; onConfirm: (c: DuplicateChoice) => void; onCancel: () => void }) {
  const [choice, setChoice] = React.useState<DuplicateChoice>('keep_both');
  const name = React.useId();
  if (!plan) return null;

  const uploadCount = plan.accepted + (choice === 'skip' ? 0 : plan.duplicates);
  const rejectedByReason = new Map<string, number>();
  for (const r of plan.rejected) rejectedByReason.set(r.reason, (rejectedByReason.get(r.reason) ?? 0) + 1);

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {plan.duplicates > 0 ? `${formatNumber(plan.duplicates)} ${plan.duplicates === 1 ? 'file already exists' : 'files already exist'}` : 'Some files can’t be uploaded'}
          </DialogTitle>
          <DialogDescription>
            {plan.duplicates > 0 ? 'Choose what to do. This applies to all of them.' : 'The rest will upload as normal.'}
          </DialogDescription>
        </DialogHeader>

        {plan.rejected.length > 0 && (
          <div className="flex flex-col gap-2 rounded-lg border border-warning-border bg-warning-bg p-3 text-sm">
            <p className="flex items-center gap-2 font-medium text-warning">
              <AlertTriangle aria-hidden className="size-4" />
              {formatNumber(plan.rejected.length)} {plan.rejected.length === 1 ? 'file' : 'files'} will be left out
            </p>
            <ul className="flex max-h-40 flex-col gap-1 overflow-auto text-fg-muted">
              {plan.rejected.slice(0, 6).map((r, i) => (
                <li key={i} className="flex flex-col">
                  <span className="truncate text-fg" title={r.name}>{r.relativePath ? `${r.relativePath}/` : ''}{r.name}</span>
                  <span className="text-xs">{r.reason}</span>
                </li>
              ))}
            </ul>
            {plan.rejected.length > 6 && (
              <p className="text-xs text-fg-muted">
                and {formatNumber(plan.rejected.length - 6)} more ({[...rejectedByReason.entries()].map(([r, n]) => `${n} × ${r.toLowerCase()}`).slice(0, 2).join(', ')})
              </p>
            )}
          </div>
        )}

        {plan.duplicates > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">What should happen to files that already exist?</legend>
            {OPTIONS.map((o) => (
              <label
                key={o.value}
                className={cn(
                  'flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring',
                  choice === o.value ? 'border-primary bg-primary-soft' : 'border-border hover:bg-surface-muted',
                )}
              >
                <input type="radio" name={name} value={o.value} checked={choice === o.value} onChange={() => setChoice(o.value)} className="mt-1 accent-[var(--primary)]" />
                <span className="flex flex-col">
                  <span className="text-sm font-medium text-fg">{o.title}</span>
                  <span className="text-xs text-fg-muted">{o.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Go back
          </Button>
          <Button onClick={() => onConfirm(choice)} disabled={uploadCount === 0}>
            {plan.duplicates > 0 && <Copy aria-hidden />}
            {uploadCount === 0 ? 'Nothing to upload' : `Upload ${formatNumber(uploadCount)} ${uploadCount === 1 ? 'file' : 'files'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
