import * as React from 'react';
import {
  AlertTriangle, Ban, CheckCircle2, CircleDashed, Clock, FileClock, Hourglass, Loader2, MinusCircle,
  PauseCircle, ShieldAlert, ShieldCheck, ShieldQuestion, ScanSearch, Upload, XCircle, Archive, TimerOff,
} from 'lucide-react';
import type {
  ClientStatus, ExportStatus, FileStatus, PortalStatus, ScanStatus, UploadSessionStatus,
} from '@scenox/shared';
import { Badge, type BadgeTone } from './badge';

type Meta = { label: string; tone: BadgeTone; icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>; spin?: boolean };

export const STATUS_META = {
  file: {
    uploading: { label: 'Uploading', tone: 'info', icon: Upload },
    processing: { label: 'Processing', tone: 'info', icon: Loader2, spin: true },
    ready: { label: 'Ready', tone: 'success', icon: CheckCircle2 },
    quarantined: { label: 'Quarantined', tone: 'danger', icon: ShieldAlert },
    failed: { label: 'Failed', tone: 'danger', icon: XCircle },
    cancelled: { label: 'Cancelled', tone: 'neutral', icon: Ban },
  } satisfies Record<FileStatus, Meta>,
  scan: {
    pending: { label: 'Scan pending', tone: 'neutral', icon: Clock },
    scanning: { label: 'Scanning', tone: 'info', icon: ScanSearch },
    clean: { label: 'Clean', tone: 'success', icon: ShieldCheck },
    infected: { label: 'Infected', tone: 'danger', icon: ShieldAlert },
    skipped: { label: 'Scan skipped', tone: 'neutral', icon: MinusCircle },
    failed: { label: 'Scan failed', tone: 'warning', icon: ShieldQuestion },
  } satisfies Record<ScanStatus, Meta>,
  portal: {
    active: { label: 'Active', tone: 'success', icon: CheckCircle2 },
    disabled: { label: 'Disabled', tone: 'neutral', icon: PauseCircle },
    expired: { label: 'Expired', tone: 'warning', icon: TimerOff },
  } satisfies Record<PortalStatus, Meta>,
  session: {
    active: { label: 'In progress', tone: 'info', icon: Loader2, spin: true },
    completed: { label: 'Completed', tone: 'success', icon: CheckCircle2 },
    abandoned: { label: 'Abandoned', tone: 'warning', icon: AlertTriangle },
    failed: { label: 'Failed', tone: 'danger', icon: XCircle },
  } satisfies Record<UploadSessionStatus, Meta>,
  client: {
    active: { label: 'Active', tone: 'success', icon: CheckCircle2 },
    disabled: { label: 'Disabled', tone: 'neutral', icon: PauseCircle },
  } satisfies Record<ClientStatus, Meta>,
  export: {
    queued: { label: 'Queued', tone: 'neutral', icon: Hourglass },
    processing: { label: 'Preparing', tone: 'info', icon: Loader2, spin: true },
    ready: { label: 'Ready', tone: 'success', icon: Archive },
    failed: { label: 'Failed', tone: 'danger', icon: XCircle },
    expired: { label: 'Expired', tone: 'neutral', icon: FileClock },
  } satisfies Record<ExportStatus, Meta>,
} as const;

export type StatusKind = keyof typeof STATUS_META;

const FALLBACK: Meta = { label: 'Unknown', tone: 'neutral', icon: CircleDashed };

/**
 * <StatusBadge kind="file" status="quarantined" />
 * kinds: file | scan | portal | session | client | export. Always renders icon + text (never color alone).
 */
export function StatusBadge({ kind, status, label, className }: { kind: StatusKind; status: string; label?: string; className?: string }) {
  const meta = ((STATUS_META[kind] as Record<string, Meta>)[status] ?? FALLBACK) as Meta;
  const Icon = meta.icon;
  return (
    <Badge tone={meta.tone} className={className}>
      <Icon aria-hidden className={meta.spin ? 'animate-spin' : undefined} />
      {label ?? meta.label}
    </Badge>
  );
}
