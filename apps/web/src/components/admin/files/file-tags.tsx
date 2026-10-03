'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Braces, Link2, Plus, Tag as TagIcon, X } from 'lucide-react';
import { formatNumber, type BulkTagRequest, type FileDTO, type SignedUrlResponse, type UpdateFileRequest } from '@scenox/shared';
import { api, errorMessage } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { copyText } from '@/lib/hooks/clipboard';
import { usePermission } from '@/lib/hooks/use-me';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SimpleSelect } from '@/components/ui/select';
import { toast } from '@/components/ui/toaster';
import { formatDateTime } from '../relative-time';
import { TagInput } from '../tag-input';
import { useInvalidateFiles } from './file-dialogs';

// ───────────────────────── tags ─────────────────────────

/** Tags are lowercase identifiers: trimmed, inner whitespace becomes "-". Returns '' for an unusable value. */
export const normalizeTag = (raw: string) => raw.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9:_.-]/g, '').slice(0, 50);
export const validateTag = (t: string) => (t.length > 0 && t.length <= 50 ? null : 'Tags can be 1–50 characters (letters, numbers, - _ . :)');

/** Small read-only tag badges. */
export function TagList({ tags, max = 4, className }: { tags: string[]; max?: number; className?: string }) {
  if (!tags || tags.length === 0) return null;
  const shown = tags.slice(0, max);
  const rest = tags.length - shown.length;
  return (
    <ul className={cn('mt-1 flex flex-wrap gap-1', className)} aria-label="Tags">
      {shown.map((t) => (
        <li key={t} className="inline-flex max-w-32 items-center gap-1 truncate rounded-md border border-border bg-surface-muted px-1.5 py-px text-[11px] font-medium leading-4 text-fg-muted" title={t}>
          <TagIcon className="size-2.5 shrink-0 text-fg-subtle" aria-hidden />
          <span className="truncate">{t}</span>
        </li>
      ))}
      {rest > 0 && <li className="inline-flex items-center rounded-md px-1 py-px text-[11px] font-medium leading-4 text-fg-subtle" title={tags.slice(max).join(', ')}>+{rest}</li>}
    </ul>
  );
}

/** Add/remove tags on one file (PATCH addTags / removeTags). */
export function FileTagsEditor({ file }: { file: FileDTO }) {
  const canEdit = usePermission('files.manage');
  const qc = useQueryClient();
  const invalidate = useInvalidateFiles();
  const [draft, setDraft] = React.useState('');
  const [error, setError] = React.useState<string>();
  const inputId = React.useId();

  const update = useMutation({
    mutationFn: (body: UpdateFileRequest) => api.patch<FileDTO>(`/files/${file.id}`, body),
    onSuccess: (f) => {
      qc.setQueryData(queryKeys.files.detail(f.id), f);
      invalidate();
    },
    onError: (e) => toast.error("Couldn't update tags", { description: errorMessage(e) }),
  });

  function add(e: React.FormEvent) {
    e.preventDefault();
    const tags = draft.split(/[,;\n]+/).map(normalizeTag).filter(Boolean).filter((t) => !file.tags.includes(t));
    if (tags.length === 0) {
      setError(draft.trim() ? 'This file already has that tag' : 'Type a tag, then press Enter');
      return;
    }
    setError(undefined);
    update.mutate({ addTags: Array.from(new Set(tags)) }, { onSuccess: () => setDraft('') });
  }

  return (
    <section aria-labelledby={`${inputId}-h`}>
      <h3 id={`${inputId}-h`} className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg"><TagIcon className="size-4 text-fg-subtle" aria-hidden /> Tags</h3>
      {file.tags.length > 0 ? (
        <ul className="mb-3 flex flex-wrap gap-1.5" aria-label="Tags on this file">
          {file.tags.map((t) => (
            <li key={t} className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-muted py-0.5 pl-2 text-xs font-medium text-fg" style={{ paddingRight: canEdit ? '0.25rem' : '0.5rem' }}>
              {t}
              {canEdit && (
                <button
                  type="button"
                  aria-label={`Remove tag ${t}`}
                  disabled={update.isPending}
                  onClick={() => update.mutate({ removeTags: [t] })}
                  className="rounded p-0.5 text-fg-subtle transition-colors hover:bg-border hover:text-fg disabled:opacity-50"
                >
                  <X className="size-3" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-3 text-sm text-fg-subtle">No tags yet. Tags help scripts and integrations find the files they need, for example <code className="rounded bg-surface-muted px-1 font-mono text-xs">shopify</code>.</p>
      )}
      {canEdit && (
        <form onSubmit={add} className="flex items-start gap-2" noValidate>
          <Field label={<span className="sr-only">Add a tag</span>} error={error} className="flex-1">
            <Input id={inputId} value={draft} onChange={(e) => { setDraft(e.target.value); setError(undefined); }} placeholder="Add a tag…" maxLength={200} autoComplete="off" spellCheck={false} />
          </Field>
          <Button type="submit" variant="outline" loading={update.isPending}>{!update.isPending && <Plus aria-hidden />} Add</Button>
        </form>
      )}
    </section>
  );
}

/** Read-only view of `meta` (written by integrations through the API). Renders nothing when empty. */
export function IntegrationData({ meta }: { meta: Record<string, unknown> | null | undefined }) {
  const text = React.useMemo(() => (meta && Object.keys(meta).length > 0 ? JSON.stringify(meta, null, 2) : ''), [meta]);
  if (!text) return null;
  return (
    <section aria-labelledby="file-meta-heading">
      <h3 id="file-meta-heading" className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg"><Braces className="size-4 text-fg-subtle" aria-hidden /> Integration data</h3>
      <div className="overflow-hidden rounded-lg border border-border bg-surface-muted">
        <div className="flex items-center justify-between border-b border-border px-3 py-1">
          <span className="text-xs text-fg-subtle">Read-only · set by integrations via the API</span>
          <CopyButton value={text} label="Copy integration data" className="size-7" />
        </div>
        <pre tabIndex={0} className="max-h-56 overflow-auto whitespace-pre-wrap break-all px-3 py-2.5 font-mono text-xs leading-5 text-fg focus-visible:outline-2 focus-visible:outline-ring">{text}</pre>
      </div>
    </section>
  );
}

// ───────────────────────── share link ─────────────────────────

const EXPIRY = [
  { value: '3600', label: '1 hour', words: '1 hour' },
  { value: '86400', label: '24 hours', words: '24 hours' },
  { value: '604800', label: '7 days', words: '7 days' },
] as const;

/** Creates a signed, time-limited public URL for a file and copies it. */
export function ShareLinkDialog({ file, onOpenChange }: { file: FileDTO | null; onOpenChange: (open: boolean) => void }) {
  const [expiry, setExpiry] = React.useState<string>('86400');
  const [result, setResult] = React.useState<{ url: string; expiresAt: string; words: string } | null>(null);

  React.useEffect(() => {
    if (file) {
      setExpiry('86400');
      setResult(null);
    }
  }, [file?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = useMutation({
    mutationFn: async () => {
      const r = await api.post<SignedUrlResponse>(`/files/${file!.id}/signed-url`, { expiresIn: Number(expiry) });
      return { ...r, url: new URL(r.url, window.location.origin).toString() };
    },
    onSuccess: async (r) => {
      const words = EXPIRY.find((x) => x.value === expiry)?.words ?? '';
      setResult({ url: r.url, expiresAt: r.expiresAt, words });
      const copied = await copyText(r.url);
      if (copied) toast.success(`Link copied — expires in ${words}`);
      else toast.info('Link ready', { description: 'Your browser blocked automatic copying. Use the copy button in the dialog.' });
    },
    onError: (e) => toast.error("Couldn't create a share link", { description: errorMessage(e) }),
  });

  return (
    <Dialog open={!!file} onOpenChange={(o) => !create.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Copy share link</DialogTitle>
          <DialogDescription>
            Anyone with the link can download <span className="font-medium text-fg">{file?.name}</span> until it expires. No sign-in needed.
          </DialogDescription>
        </DialogHeader>
        <Field label="Link expires after">
          <SimpleSelect value={expiry} onValueChange={(v) => { setExpiry(v); setResult(null); }} options={EXPIRY.map((x) => ({ value: x.value, label: x.label }))} />
        </Field>
        {result && (
          <div className="grid gap-1.5" aria-live="polite">
            <p className="text-xs font-medium text-fg-muted">Share link</p>
            <div className="flex items-center gap-1 rounded-lg border border-border-strong bg-surface-muted py-1 pl-3 pr-1">
              <input readOnly value={result.url} aria-label="Share link" onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 truncate bg-transparent font-mono text-xs outline-none" />
              <CopyButton value={result.url} label="Copy share link" />
            </div>
            <p className="text-xs text-fg-subtle">Expires {formatDateTime(result.expiresAt)}</p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={create.isPending}>{result ? 'Done' : 'Cancel'}</Button>
          <Button onClick={() => create.mutate()} loading={create.isPending}>{!create.isPending && <Link2 aria-hidden />} {result ? 'Create a new link' : 'Create & copy link'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── bulk tagging ─────────────────────────

const CHUNK = 500;

export function BulkTagDialog({
  mode, fileIds, suggestions, onOpenChange,
}: { mode: 'add' | 'remove' | null; fileIds: string[]; suggestions?: string[]; onOpenChange: (open: boolean) => void }) {
  const invalidate = useInvalidateFiles();
  const [tags, setTags] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string>();
  React.useEffect(() => {
    if (mode) {
      setTags([]);
      setError(undefined);
    }
  }, [mode]);

  const run = useMutation({
    mutationFn: async () => {
      let updated = 0;
      for (let i = 0; i < fileIds.length; i += CHUNK) {
        const body: BulkTagRequest = { fileIds: fileIds.slice(i, i + CHUNK), ...(mode === 'add' ? { addTags: tags } : { removeTags: tags }) };
        const r = await api.post<{ updated: number }>('/files/tags', body);
        updated += r.updated;
      }
      return updated;
    },
    onSuccess: (updated) => {
      const noun = `${formatNumber(updated)} ${updated === 1 ? 'file' : 'files'}`;
      toast.success(mode === 'add' ? `Tagged ${noun}` : `Removed tags from ${noun}`);
      invalidate();
      onOpenChange(false);
    },
    onError: (e) => {
      invalidate();
      toast.error(mode === 'add' ? "Couldn't add the tags" : "Couldn't remove the tags", { description: errorMessage(e) });
    },
  });

  const n = fileIds.length;
  const noun = `${formatNumber(n)} ${n === 1 ? 'file' : 'files'}`;
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (tags.length === 0) return setError('Add at least one tag');
    setError(undefined);
    run.mutate();
  }

  return (
    <Dialog open={!!mode} onOpenChange={(o) => !run.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{mode === 'add' ? `Add tags to ${noun}` : `Remove tags from ${noun}`}</DialogTitle>
            <DialogDescription>{mode === 'add' ? 'The tags are added to each selected file. Existing tags are kept.' : 'The tags are removed from each selected file that has them.'}</DialogDescription>
          </DialogHeader>
          <Field label="Tags" error={error} hint="Press Enter or comma after each tag.">
            <TagInput value={tags} onChange={(t) => { setTags(t); setError(undefined); }} normalize={normalizeTag} validate={validateTag} suggestions={mode === 'remove' ? suggestions : undefined} placeholder="shopify" aria-label="Tags" />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={run.isPending}>Cancel</Button>
            <Button type="submit" loading={run.isPending}>{mode === 'add' ? 'Add tags' : 'Remove tags'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ───────────────────────── list filter ─────────────────────────

export type TagFilterMode = 'has' | 'not';

/** FilterBar control: "Tag" (tag=) with a "Doesn't have tag" variant (notTag=). */
export function TagFilter({ tag, mode, onChange }: { tag?: string; mode: TagFilterMode; onChange: (tag: string | undefined, mode: TagFilterMode) => void }) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState(tag ?? '');
  const [draftMode, setDraftMode] = React.useState<TagFilterMode>(mode);
  React.useEffect(() => {
    if (open) {
      setDraft(tag ?? '');
      setDraftMode(mode);
    }
  }, [open, tag, mode]);

  function apply(e: React.FormEvent) {
    e.preventDefault();
    const t = normalizeTag(draft);
    onChange(t || undefined, draftMode);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className={cn('max-w-56 justify-start font-normal', tag && 'border-primary-soft-border bg-primary-soft text-primary-soft-fg hover:bg-primary-soft')} aria-label={tag ? `Tag filter: ${mode === 'not' ? 'not tagged' : 'tagged'} ${tag}` : 'Filter by tag'}>
          <TagIcon aria-hidden />
          <span className="truncate">{tag ? `${mode === 'not' ? 'Not tagged' : 'Tag'}: ${tag}` : 'Tag'}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <form onSubmit={apply} className="grid gap-3">
          <div role="group" aria-label="Tag filter type" className="grid grid-cols-2 gap-0.5 rounded-lg border border-border bg-surface-muted p-0.5">
            {([['has', 'Has tag'], ['not', 'Not tagged']] as const).map(([v, label]) => (
              <button
                key={v}
                type="button"
                aria-pressed={draftMode === v}
                onClick={() => setDraftMode(v)}
                className={cn('rounded-md px-2 py-1.5 text-sm font-medium transition-colors', draftMode === v ? 'bg-surface text-fg shadow-xs' : 'text-fg-muted hover:text-fg')}
              >
                {label}
              </button>
            ))}
          </div>
          <Field label="Tag" hint={draftMode === 'not' ? 'Show files that do not have this tag, e.g. not yet synced.' : 'Show files that have this tag.'}>
            <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="shopify" autoComplete="off" spellCheck={false} autoFocus />
          </Field>
          <div className="flex justify-between gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={!tag && !draft} onClick={() => { onChange(undefined, 'has'); setOpen(false); }}>Clear</Button>
            <Button type="submit" size="sm">Apply</Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
