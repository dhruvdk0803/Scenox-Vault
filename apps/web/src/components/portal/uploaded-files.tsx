'use client';

import * as React from 'react';
import { format } from 'date-fns';
import { FileText, Trash2 } from 'lucide-react';
import { formatBytes, formatNumber, type PublicFileDTO } from '@scenox/shared';
import { Button, Card, ConfirmDialog, Skeleton } from '@/components/ui';
import { portalApi } from '@/lib/upload';
import { errorMessage } from '@/lib/api';
import { toast } from 'sonner';

const PAGE = 50;

export function UploadedFiles({ token, sessionToken, canDelete, refreshKey }: { token: string; sessionToken: string; canDelete: boolean; refreshKey: number }) {
  const [files, setFiles] = React.useState<PublicFileDTO[] | null>(null);
  const [shown, setShown] = React.useState(PAGE);
  const [target, setTarget] = React.useState<PublicFileDTO | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    portalApi.files(token, sessionToken).then(
      (f) => !cancelled && setFiles(f.filter((x) => x.status !== 'cancelled' && x.status !== 'failed')),
      () => !cancelled && setFiles((prev) => prev ?? []),
    );
    return () => {
      cancelled = true;
    };
  }, [token, sessionToken, refreshKey]);

  if (files && files.length === 0) return null;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="uploaded-heading">
      <h2 id="uploaded-heading" className="text-base font-semibold text-fg">
        Your uploaded files {files && <span className="font-normal text-fg-subtle tabular-nums">({formatNumber(files.length)})</span>}
      </h2>
      <Card className="overflow-hidden shadow-xs">
        {!files ? (
          <div className="flex flex-col gap-2 p-4">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        ) : (
          <ul className="divide-y divide-border/60">
            {files.slice(0, shown).map((f) => (
              <li key={f.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                <FileText aria-hidden className="size-4 shrink-0 text-fg-subtle" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-fg" title={f.name}>{f.name}</p>
                  <p className="truncate text-xs tabular-nums text-fg-subtle">
                    {f.relativePath ? `${f.relativePath} · ` : ''}
                    {formatBytes(f.size)}
                    {f.uploadedAt ? ` · ${format(new Date(f.uploadedAt), 'MMM d, h:mm a')}` : ''}
                  </p>
                </div>
                {canDelete && (
                  <button
                    type="button" aria-label={`Delete ${f.name}`} onClick={() => setTarget(f)}
                    className="-mr-2 inline-flex size-10 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-danger-bg hover:text-danger sm:size-8"
                  >
                    <Trash2 aria-hidden className="size-4" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {files && files.length > shown && (
          <div className="border-t border-border p-2 text-center">
            <Button variant="ghost" size="sm" onClick={() => setShown((n) => n + PAGE)}>
              Show more
            </Button>
          </div>
        )}
      </Card>
      <ConfirmDialog
        open={!!target} onOpenChange={(o) => !o && setTarget(null)} destructive title="Delete this file?"
        description={target ? `“${target.name}” will be permanently removed.` : undefined} confirmLabel="Delete"
        onConfirm={async () => {
          if (!target) return;
          try {
            await portalApi.deleteFile(token, sessionToken, target.id);
            setFiles((prev) => prev?.filter((x) => x.id !== target.id) ?? prev);
          } catch (e) {
            toast.error(errorMessage(e, 'We couldn’t delete that file. Please try again.'));
            throw e;
          }
        }}
      />
    </section>
  );
}
