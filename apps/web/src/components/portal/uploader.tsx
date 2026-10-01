'use client';

import * as React from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { formatBytes, formatNumber, type PublicPortalDTO, type StartSessionRequest, type UploadEngineConfig } from '@scenox/shared';
import { Button } from '@/components/ui';
import { ApiClientError } from '@/lib/api';
import {
  ensureSession, getDefaultKV, makeClientKey, makeFingerprint, portalApi, preflightAll, QueueStore, scanDataTransfer, summarizePending,
  useUploadManager, validateStoredSession, type AddInput, type PendingRecord, type PickedFile, type StoredSession,
} from '@/lib/upload';
import { accessStore, EMPTY_INTAKE, intakeStore, type IntakeValues } from './branding';
import { CompleteScreen } from './complete-screen';
import { ConnectionBanner } from './connection-banner';
import { DragOverlay, Dropzone, HiddenPickers, useWindowDrop, type DropzoneHandle } from './dropzone';
import { IntakeForm, needsIntake } from './intake-form';
import { PortalIntro } from './intro';
import { PreflightDialog, reasonText, type DuplicateChoice, type PreflightPlan } from './preflight-dialog';
import { QueueList, type QueueActions } from './queue-list';
import { ResumeCard } from './resume-card';
import { MobileUploadBar, SelectionReview } from './selection-review';
import { UploadedFiles } from './uploaded-files';
import { MobileProgressBar, OverallProgress } from './upload-progress';
import { usePageGuards } from './use-page-guards';
import { useSelection } from './use-selection';
import { PortalShell } from './shell';
import type { Branding } from '@scenox/shared';

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
interface PlanState {
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

export function Uploader({ token, portal, uploadConfig, branding }: { token: string; portal: Portal; uploadConfig?: UploadEngineConfig; branding: Branding }) {
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
  const [session, setSession] = React.useState<StoredSession | null>(null);
  const [pending, setPending] = React.useState<PendingRecord[]>([]);
  const [prep, setPrep] = React.useState<{ label: string } | null>(null);
  const [prepError, setPrepError] = React.useState<string | null>(null);
  const [plan, setPlan] = React.useState<PlanState | null>(null);
  const [filesRefresh, setFilesRefresh] = React.useState(0);

  const hasWork = snapshot.items.length > 0;
  const view: 'select' | 'uploading' | 'complete' = !hasWork ? 'select' : snapshot.stats.finished ? 'complete' : 'uploading';
  const needsIntakeStep = needsIntake(portal) && !intake;

  usePageGuards(snapshot.stats.running);

  /* previously stored session (for "Your uploaded files") */
  React.useEffect(() => {
    let live = true;
    void validateStoredSession(kv, portalApi, token).then((s) => live && s && setSession(s));
    return () => {
      live = false;
    };
  }, [kv, token]);

  /* unfinished uploads from an earlier visit */
  React.useEffect(() => {
    if (!portal.allowResume || view !== 'select') return;
    let live = true;
    void queue.list().then((r) => live && setPending(r)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [queue, portal.allowResume, view]);

  /* queue drained → tell the server once per run */
  const completedRun = React.useRef(0);
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
      void portalApi.complete(token, s.sessionToken, { filesUploaded: stats.completedFiles, bytesUploaded: stats.completedBytes, filesFailed: stats.failedFiles }).catch(() => undefined);
    }
    setFilesRefresh((k) => k + 1);
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
        setSession(sess);
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
      if (!hasWork) return void selection.scanDrop(dt);
      const acc: PickedFile[] = [];
      await scanDataTransfer(dt, { onFiles: (f) => acc.push(...f) });
      if (acc.length) void prepare(acc, false);
    },
    [hasWork, prepare, selection],
  );

  const dragging = useWindowDrop(!needsIntakeStep && view !== 'complete' && !prep && !plan, (dt) => void onDrop(dt));

  /* ───────── queue actions ───────── */

  const reopenSession = React.useCallback(async () => {
    // After the queue drained the session may have been closed; get an active one before retrying.
    if (!snapshot.stats.finished) return;
    try {
      const s = await ensureSession({ kv, api: portalApi, portalToken: token, accessToken: accessToken(), intake: toPayload(intakeRef.current), totals: { totalFiles: snapshot.stats.failedFiles, totalBytes: 0 } });
      manager.setSession({ sessionId: s.sessionId, sessionToken: s.sessionToken });
      setSession(s);
    } catch {
      /* the retry itself will surface the problem */
    }
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

  /* ───────── render ───────── */

  const sticky = (view === 'select' && selection.items.length > 0) || view === 'uploading';
  const dropzone = (
    <Dropzone
      ref={pickers} allowFolders={portal.allowFolders} onPick={onPicked} scanning={selection.scan} onCancelScan={selection.cancelScan}
      maxFileSizeBytes={portal.maxFileSizeBytes} allowedExtensions={portal.allowedExtensions}
    />
  );

  let body: React.ReactNode;
  if (needsIntakeStep) {
    body = (
      <IntakeForm
        requirements={portal} initial={intake}
        onSubmit={(v) => {
          intakeStore.save(token, v);
          setIntake(v);
        }}
      />
    );
  } else if (view === 'uploading') {
    body = (
      <div className="flex flex-col gap-4">
        <ConnectionBanner offline={snapshot.offline} sessionExpired={snapshot.sessionExpired} />
        <OverallProgress
          snapshot={snapshot} onPauseAll={() => manager.pauseAll()} onResumeAll={() => manager.resumeAll()}
          onCancelAll={() => manager.cancelAll()} onAddMore={() => addMore.current?.openFiles()}
        />
        {prep && (
          <p className="flex items-center gap-2 text-sm text-fg-muted" role="status">
            <Loader2 aria-hidden className="size-4 animate-spin" /> {prep.label}
          </p>
        )}
        {prepError && <p role="alert" className="text-sm text-danger">{prepError}</p>}
        <QueueList items={snapshot.items} actions={actions} />
        <p className="text-center text-xs text-fg-subtle">Keep this tab open until the upload finishes. It’s safe to switch to other apps.</p>
      </div>
    );
  } else if (view === 'complete') {
    body = (
      <div className="flex flex-col gap-8">
        <ConnectionBanner offline={snapshot.offline} sessionExpired={snapshot.sessionExpired} />
        <CompleteScreen
          snapshot={snapshot} actions={actions} canUploadMore={portal.allowMultipleSessions}
          onRetryFailed={() => void reopenSession().then(() => manager.retryFailed())}
          onUploadMore={() => {
            manager.reset();
            selection.clear();
          }}
        />
        {portal.allowClientViewFiles && session && <UploadedFiles token={token} sessionToken={session.sessionToken} canDelete={portal.allowClientDeleteFiles} refreshKey={filesRefresh} />}
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-4">
          {pending.length > 0 && selection.items.length === 0 && !selection.scan && (
            <ResumeCard
              {...summarizePending(pending)}
              onResume={() => (pending.some((p) => p.relativePath) && portal.allowFolders ? pickers.current?.openFolder() : pickers.current?.openFiles())}
              onDiscard={() => void queue.clear().then(() => setPending([]))}
            />
          )}
          {selection.items.length === 0 ? (
            dropzone
          ) : (
            <>
              {selection.scan && (
                <p className="flex items-center gap-2 text-sm text-fg-muted" role="status">
                  <Loader2 aria-hidden className="size-4 animate-spin" /> Scanning folder… <span className="tabular-nums">{formatNumber(selection.scan.found)}</span> files
                  <Button variant="link" size="sm" onClick={selection.cancelScan} className="ml-1">Stop</Button>
                </p>
              )}
              <SelectionReview
                items={selection.items} totalBytes={selection.totalBytes} busy={prep} error={prepError} resumeMatches={resumeMatches}
                onRemove={(id) => selection.removeIds(new Set([id]))} onRemoveFolder={selection.removeFolder} onClear={selection.clear}
                onAddMore={() => pickers.current?.openFiles()} onUpload={uploadSelection}
              />
              {/* keep the inputs mounted for "Add more" */}
              <HiddenPickers ref={pickers} allowFolders={portal.allowFolders} onPick={onPicked} />
            </>
          )}
        </div>
        {portal.allowClientViewFiles && session && selection.items.length === 0 && (
          <UploadedFiles token={token} sessionToken={session.sessionToken} canDelete={portal.allowClientDeleteFiles} refreshKey={filesRefresh} />
        )}
      </div>
    );
  }

  return (
    <PortalShell branding={branding} logoUrl={portal.logoUrl} bottomInset={sticky}>
      <div className="flex flex-col gap-8">
        <PortalIntro portal={portal} compact={view !== 'select' && !needsIntakeStep} />
        {body}
      </div>
      <HiddenPickers ref={addMore} allowFolders={false} onPick={onPicked} />
      <DragOverlay visible={dragging} />
      <PreflightDialog
        plan={plan ? toDialogPlan(plan) : null}
        onCancel={() => {
          if (plan?.fromSelection) selection.removeIds(new Set(plan.rejected.map((r) => r.c.selId!).filter((x) => x !== undefined)));
          setPlan(null);
        }}
        onConfirm={(choice) => {
          if (!plan) return;
          commit(plan.accepted, plan.duplicates, choice, plan.fromSelection);
          setPlan(null);
        }}
      />
      {view === 'select' && selection.items.length > 0 && !needsIntakeStep && (
        <MobileUploadBar label={`Upload ${formatBytes(selection.totalBytes)}`} busyLabel={prep?.label} onClick={uploadSelection} />
      )}
      {view === 'uploading' && <MobileProgressBar snapshot={snapshot} onPauseAll={() => manager.pauseAll()} onResumeAll={() => manager.resumeAll()} />}
    </PortalShell>
  );
}

function toDialogPlan(p: PlanState): PreflightPlan {
  return {
    accepted: p.accepted.length,
    acceptedBytes: p.accepted.reduce((n, c) => n + c.file.size, 0),
    rejected: p.rejected.map((r) => ({ name: r.c.name, relativePath: r.c.relativePath, reason: r.reason })),
    duplicates: p.duplicates.length,
    duplicateBytes: p.duplicates.reduce((n, c) => n + c.file.size, 0),
  };
}

