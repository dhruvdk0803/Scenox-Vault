'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ImageIcon, Trash2, Upload } from 'lucide-react';
import type { PortalDTO } from '@scenox/shared';
import { api, errorMessage } from '@/lib/api';
import { queryKeys } from '@/lib/query-keys';
import { usePermission } from '@/lib/hooks/use-me';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { toast } from '@/components/ui/toaster';

const MAX = 2 * 1024 * 1024;

function logoSrc(p: PortalDTO): string | null {
  if (!p.hasLogo || !p.url) return null;
  const token = p.url.split('?')[0]!.split('/').filter(Boolean).pop();
  return token ? `/api/public/portals/${token}/logo?v=${encodeURIComponent(p.updatedAt)}` : null;
}

export function PortalLogoCard({ portal }: { portal: PortalDTO }) {
  const canManage = usePermission('portals.manage');
  const qc = useQueryClient();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [preview, setPreview] = React.useState<string | null>(null);
  const [broken, setBroken] = React.useState(false);
  React.useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const refresh = () => void qc.invalidateQueries({ queryKey: queryKeys.portals.all });

  const upload = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return api.post<PortalDTO>(`/portals/${portal.id}/logo`, fd);
    },
    onSuccess: () => { toast.success('Logo uploaded'); setBroken(false); refresh(); },
    onError: (e) => { setPreview(null); toast.error("Couldn't upload the logo", { description: errorMessage(e) }); },
  });
  const remove = useMutation({
    mutationFn: () => api.delete<PortalDTO>(`/portals/${portal.id}/logo`),
    onSuccess: () => { toast.success('Logo removed'); setPreview(null); refresh(); },
    onError: (e) => toast.error("Couldn't remove the logo", { description: errorMessage(e) }),
  });

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpe?g|svg\+xml|webp)$/.test(file.type)) return void toast.error('Unsupported image', { description: 'Use a PNG, JPG, SVG or WebP file.' });
    if (file.size > MAX) return void toast.error('Image is too large', { description: 'Logos can be up to 2 MB.' });
    setPreview(URL.createObjectURL(file));
    upload.mutate(file);
  }

  const src = preview ?? (broken ? null : logoSrc(portal));
  const has = !!src || portal.hasLogo;

  return (
    <Card className="p-5">
      <h2 className="mb-3 text-sm font-semibold">Portal logo</h2>
      <div className="flex items-center gap-4">
        <div className="flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface-muted">
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt="Portal logo" className="max-h-full max-w-full object-contain" onError={() => setBroken(true)} />
          ) : (
            <ImageIcon className="size-6 text-fg-subtle" aria-hidden />
          )}
        </div>
        <div className="min-w-0 space-y-2">
          <p className="text-sm text-fg-muted">{has ? 'Shown at the top of the client portal.' : 'No logo. The workspace logo is used instead.'}</p>
          <p className="text-xs text-fg-subtle">PNG, JPG, SVG or WebP up to 2 MB.</p>
          {canManage && (
            <div className="flex gap-2">
              <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="sr-only" onChange={onPick} aria-label="Choose logo file" tabIndex={-1} />
              <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()} loading={upload.isPending}><Upload aria-hidden /> {portal.hasLogo ? 'Replace' : 'Upload logo'}</Button>
              {portal.hasLogo && <Button size="sm" variant="ghost" onClick={() => remove.mutate()} loading={remove.isPending}><Trash2 aria-hidden /> Remove</Button>}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
