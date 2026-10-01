'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { formatNumber, type PublicPortalDTO, type StartSessionRequest, type UploadEngineConfig } from '@scenox/shared';
import { ApiClientError } from '@/lib/api';
import {
  ensureSession, getDefaultKV, makeClientKey, makeFingerprint, portalApi, preflightAll, QueueStore, scanDataTransfer,
  useUploadManager, type AddInput, type PendingRecord, type PickedFile, type StoredSession,
} from '@/lib/upload';
import { accessStore, EMPTY_INTAKE, intakeStore, type IntakeValues } from './branding';
import { useWindowDrop, type DropzoneHandle } from './dropzone';
import { needsIntake } from './intake-form';
import { reasonText, type DuplicateChoice, type PreflightPlan } from './preflight-dialog';
import type { QueueActions } from './queue-list';
import { useSelection } from './use-selection';

type Portal = NonNullable<PublicPortalDTO['portal']>;

interface Candidate {
  file: File;
  name: string;
  relativePath: string;
  selId?: number;
}
interface Keyed extends Candidate {
  clientKey: string;
}
export interface PlanState {
  accepted: Keyed[];
  duplicates: Keyed[];
  rejected: { c: Keyed; reason: string }[];
  fromSelection: boolean;
}

const toPayload = (v: IntakeValues | null): Omit<StartSessionRequest, 'totalFiles' | 'totalBytes'> => {
  const out: Omit<StartSessionRequest, 'totalFiles' | 'totalBytes'> = {};
  if (v?.name) out.name = v.name;
  if (v?.email) out.email = v.email;
  if (v?.company) out.company = v.company;
  if (v?.message) out.message = v.message;
  return out;
};

export function toDialogPlan(p: PlanState): PreflightPlan {
  return {
    accepted: p.accepted.length,
    acceptedBytes: p.accepted.reduce((n, c) => n + c.file.size, 0),
    rejected: p.rejected.map((r) => ({ name: r.c.name, relativePath: r.c.relativePath, reason: r.reason })),
    duplicates: p.duplicates.length,
    duplicateBytes: p.duplicates.reduce((n, c) => n + c.file.size, 0),
  };
}

export interface UploadControllerOptions {
  token: string;
  portal: Portal;
  uploadConfig?: UploadEngineConfig;
  /** Called after the queue drained and the server was told (dashboard/browse/uploads should refresh). */
  onRunComplete: () => void;
  /** Called when files are dropped anywhere on the window (so the shell can switch to the Upload tab). */
  onWindowDrop: () => void;
}

/**
 * Everything the upload flow needs, hoisted out of the Upload tab so the engine keeps running while the
 * client browses other tabs. Behaviour is unchanged from the original single-page uploader.
 */
export function useUploadController({ token, portal, uploadConfig, onRunComplete, onWindowDrop }: UploadControllerOptions) {
  const kv = getDefaultKV();
  const queue = React.useMemo(() => new QueueStore(kv, token), [kv, token]);
  const [intake, setIntake] = React.useState<IntakeValues | null>(() => (needsIntake(portal) ? intakeStore.load(token) : EMPTY_INTAKE));
  const intakeRef = React.useRef(intake);
  intakeRef.current = intake;
  const totalsRef = React.useRef({ totalFiles: 0, totalBytes: 0 });
  const accessToken = () => accessStore.load(token)?.accessToken ?? null;

  const { manager, snapshot } = useUploadManager(() => ({
    portalToken: token,
    config: uploadConfig,
    allowResume: portal.allowResume,
    renewSession: async () => {
      try {
        const s = await ensureSession({ kv, api: portalApi, portalToken: token, accessToken: accessToken(), intake: toPayload(intakeRef.current), totals: totalsRef.current, forceNew: true });
        return { sessionId: s.sessionId, sessionToken: s.sessionToken };
      } catch {
        return null;
      }
    },
  }));

  const selection = useSelection();
  const pickers = React.useRef<DropzoneHandle>(null);
  const addMore = React.useRef<DropzoneHandle>(null);
  const [pending, setPending] = React.useState<PendingRecord[]>([]);
  const [prep, setPrep] = React.useState<{ label: string } | null>(null);
  const [prepError, setPrepError] = React.useState<string | null>(null);
  const [plan, setPlan] = React.useState<PlanState | null>(null);

  const hasWork = snapshot.items.length > 0;
  const view: 'select' | 'uploading' | 'complete' = !hasWork ? 'select' : snapshot.stats.finished ? 'complete' : 'uploading';
  const needsIntakeStep = needsIntake(portal) && !intake;

  /* unfinished uploads from an earlier visit */
  React.useEffect(() => {
    if (!portal.allowResume || view !== 'select') return;
    let live = true;
    void queue.list().then((r) => live && setPending(r)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [queue, portal.allowResume, view]);

  /* queue drained → tell the server once per run, then refresh the dashboard data */
  const completedRun = React.useRef(0);
  const onRunCompleteRef = React.useRef(onRunComplete);
  onRunCompleteRef.current = onRunComplete;
  React.useEffect(() => {
    const { stats, runId } = snapshot;
    if (!stats.finished || runId === completedRun.current) return;
    completedRun.current = runId;
    if (stats.completedFiles === 0 && stats.failedFiles === 0) {
      manager.reset(); // everything was cancelled
      return;
    }
    const s = manager.getSession();
    if (s) {
      void portalApi
        .complete(token, s.sessionToken, { filesUploaded: stats.completedFiles, bytesUploaded: stats.completedBytes, filesFailed: stats.failedFiles })
        .catch(() => undefined)
        .finally(() => onRunCompleteRef.current());
    } else {
      onRunCompleteRef.current();
    }
  }, [snapshot, manager, token]);

  /* ───────── submit: session → preflight → (dialog) → queue ───────── */

  const commit = React.useCallback(
    (accepted: Keyed[], duplicates: Keyed[], choice: DuplicateChoice | null, fromSelection: boolean) => {
      const inputs: AddInput[] = accepted.map((c) => ({ file: c.file, name: c.name, relativePath: c.relativePath, clientKey: c.clientKey }));
      if (choice && choice !== 'skip') {
        for (const c of duplicates) inputs.push({ file: c.file, name: c.name, relativePath: c.relativePath, clientKey: c.clientKey, duplicateAction: choice });
      }
      if (fromSelection) selection.clear();
      if (inputs.length === 0) {
        toast.info('Nothing new to upload.');
        return;
      }
      manager.add(inputs);
      manager.start();
    },
    [manager, selection],
  );

  const prepare = React.useCallback(
    async (cands: Candidate[], fromSelection: boolean) => {
      if (cands.length === 0) return;
      setPrepError(null);
      const totalBytes = cands.reduce((n, c) => n + c.file.size, 0);
      totalsRef.current = { totalFiles: cands.length, totalBytes };
      try {
        setPrep({ label: 'Getting things ready…' });
        const open = (forceNew = false) =>
          ensureSession({ kv, api: portalApi, portalToken: token, accessToken: accessToken(), intake: toPayload(intakeRef.current), totals: totalsRef.current, forceNew });
        let sess = await open();
        const keyed: Keyed[] = cands.map((c) => ({ ...c, clientKey: makeClientKey() }));
        const files = keyed.map((c) => ({ clientKey: c.clientKey, name: c.name, relativePath: c.relativePath, size: c.file.size, type: c.file.type || undefined }));
        const run = (s: StoredSession) =>
          preflightAll(token, s.sessionToken, files, (d, t) => setPrep({ label: `Checking your files… ${formatNumber(d)} of ${formatNumber(t)}` }));
        setPrep({ label: 'Checking your files…' });
        let pre;
        try {
          pre = await run(sess);
        } catch (e) {
          if (e instanceof ApiClientError && (e.status === 401 || e.status === 403)) {
            sess = await open(true);
            pre = await run(sess);
          } else throw e;
        }
        manager.setSession({ sessionId: sess.sessionId, sessionToken: sess.sessionToken });

        const byKey = new Map(pre.results.map((r) => [r.clientKey, r]));
        const accepted: Keyed[] = [];
        const duplicates: Keyed[] = [];
        const rejected: PlanState['rejected'] = [];
        for (const c of keyed) {
          const r = byKey.get(c.clientKey);
          if (r && !r.ok) rejected.push({ c, reason: reasonText(r, portal.maxFileSizeBytes) });
          else if (r?.duplicate) duplicates.push(c);
          else accepted.push(c);
        }
        if (rejected.length === 0 && duplicates.length === 0) commit(accepted, [], null, fromSelection);
        else setPlan({ accepted, duplicates, rejected, fromSelection });
      } catch (e) {
        if (e instanceof ApiClientError && e.status === 0) setPrepError('We couldn’t reach the server. Check your connection and try again.');
        else if (e instanceof ApiClientError && e.status === 429) setPrepError('Too many requests. Please wait a moment and try again.');
        else if (e instanceof ApiClientError && e.status === 403) setPrepError('This link can’t accept uploads right now.');
        else setPrepError('Something went wrong while getting ready. Please try again.');
      } finally {
        setPrep(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kv, token, manager, commit, portal.maxFileSizeBytes],
  );

  const uploadSelection = React.useCallback(() => {
    void prepare(selection.items.map((i) => ({ file: i.file, name: i.name, relativePath: i.relativePath, selId: i.id })), true);
  }, [prepare, selection.items]);

  const onPicked = React.useCallback(
    (picked: PickedFile[]) => {
      if (picked.length === 0) return;
      if (hasWork) void prepare(picked, false);
      else selection.add(picked);
    },
    [hasWork, prepare, selection],
  );

  const onDrop = React.useCallback(
    async (dt: DataTransfer) => {
      onWindowDrop();
      if (!hasWork) return void selection.scanDrop(dt);
      const acc: PickedFile[] = [];
      await scanDataTransfer(dt, { onFiles: (f) => acc.push(...f) });
      if (acc.length) void prepare(acc, false);
    },
    [hasWork, prepare, selection, onWindowDrop],
  );

  const dragging = useWindowDrop(!needsIntakeStep && view !== 'complete' && !prep && !plan, (dt) => void onDrop(dt));

  /* ───────── queue actions ───────── */

  const reopenSession = React.useCallback(async () => {
    // After the queue drained the session may have been closed; get an active one before retrying.
    if (!snapshot.stats.finished) return;
    try {
      const s = await ensureSession({ kv, api: portalApi, portalToken: token, accessToken: accessToken(), intake: toPayload(intakeRef.current), totals: { totalFiles: snapshot.stats.failedFiles, totalBytes: 0 } });
      manager.setSession({ sessionId: s.sessionId, sessionToken: s.sessionToken });
    } catch {
      /* the retry itself will surface the problem */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kv, manager, snapshot.stats.finished, snapshot.stats.failedFiles, token]);

  const actions = React.useMemo<QueueActions>(
    () => ({
      onPause: (id) => manager.pause(id),
      onResume: (id) => manager.resume(id),
      onCancel: (id) => manager.cancel(id),
      onRetry: (id) => void reopenSession().then(() => manager.retry(id)),
    }),
    [manager, reopenSession],
  );

  const resumeMatches = React.useMemo(() => {
    if (pending.length === 0 || selection.items.length === 0) return 0;
    const fp = new Set(pending.map((p) => p.fingerprint));
    return selection.items.reduce((n, i) => n + (fp.has(makeFingerprint({ portalToken: token, relativePath: i.relativePath, name: i.name, size: i.size, lastModified: i.lastModified })) ? 1 : 0), 0);
  }, [pending, selection.items, token]);

  return {
    manager, snapshot, selection, pickers, addMore, queue,
    intake, saveIntake: (v: IntakeValues) => { intakeStore.save(token, v); setIntake(v); }, needsIntakeStep,
    pending, setPending, prep, prepError, plan, setPlan, view, dragging, actions, resumeMatches,
    uploadSelection, onPicked, commit, reopenSession,
  };
}

export type UploadController = ReturnType<typeof useUploadController>;
