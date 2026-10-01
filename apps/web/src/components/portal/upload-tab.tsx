'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { formatBytes, formatNumber } from '@scenox/shared';
import { Button } from '@/components/ui';
import { useDashboard } from '@/lib/portal/hooks';
import { summarizePending } from '@/lib/upload';
import { CompleteScreen } from './complete-screen';
import { ConnectionBanner } from './connection-banner';
import { Dropzone, HiddenPickers } from './dropzone';
import { IntakeForm } from './intake-form';
import { usePortal } from './portal-context';
import { PortalNotes } from './portal-notes';
import { QueueList } from './queue-list';
import { ResumeCard } from './resume-card';
import { MobileUploadBar, SelectionReview } from './selection-review';
import { MobileProgressBar, OverallProgress } from './upload-progress';
import type { UploadController } from './use-upload-controller';

/** The original upload flow (dropzone → review → preflight → queue → complete), driven by the shell's controller. */
export function UploadTab({ upload }: { upload: UploadController }) {
  const { portal, canViewFiles, navigate } = usePortal();
  const dashboard = useDashboard();
  const { snapshot, selection, manager, view, pending, prep, prepError, pickers, addMore } = upload;

  const sticky = (view === 'select' && selection.items.length > 0 && !upload.needsIntakeStep) || view === 'uploading';

  let body: React.ReactNode;
  if (upload.needsIntakeStep) {
    body = <IntakeForm requirements={portal} initial={upload.intake} onSubmit={upload.saveIntake} />;
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
        <QueueList items={snapshot.items} actions={upload.actions} />
        <p className="text-center text-xs text-fg-subtle">Keep this page open until the upload finishes. You can browse other sections meanwhile; the upload carries on.</p>
      </div>
    );
  } else if (view === 'complete') {
    body = (
      <div className="flex flex-col gap-8">
        <ConnectionBanner offline={snapshot.offline} sessionExpired={snapshot.sessionExpired} />
        <CompleteScreen
          snapshot={snapshot} actions={upload.actions} canUploadMore={portal.allowMultipleSessions}
          onRetryFailed={() => void upload.reopenSession().then(() => manager.retryFailed())}
          onUploadMore={() => {
            manager.reset();
            selection.clear();
          }}
          onViewFiles={canViewFiles ? () => navigate({ tab: 'files' }) : undefined}
        />
      </div>
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        {pending.length > 0 && selection.items.length === 0 && !selection.scan && (
          <ResumeCard
            {...summarizePending(pending)}
            onResume={() => (pending.some((p) => p.relativePath) && portal.allowFolders ? pickers.current?.openFolder() : pickers.current?.openFiles())}
            onDiscard={() => void upload.queue.clear().then(() => upload.setPending([]))}
          />
        )}
        {selection.items.length === 0 ? (
          <Dropzone
            ref={pickers} allowFolders={portal.allowFolders} onPick={upload.onPicked} scanning={selection.scan} onCancelScan={selection.cancelScan}
            maxFileSizeBytes={portal.maxFileSizeBytes} allowedExtensions={portal.allowedExtensions}
          />
        ) : (
          <>
            {selection.scan && (
              <p className="flex items-center gap-2 text-sm text-fg-muted" role="status">
                <Loader2 aria-hidden className="size-4 animate-spin" /> Scanning folder… <span className="tabular-nums">{formatNumber(selection.scan.found)}</span> files
                <Button variant="link" size="sm" onClick={selection.cancelScan} className="ml-1">Stop</Button>
              </p>
            )}
            <SelectionReview
              items={selection.items} totalBytes={selection.totalBytes} busy={prep} error={prepError} resumeMatches={upload.resumeMatches}
              onRemove={(id) => selection.removeIds(new Set([id]))} onRemoveFolder={selection.removeFolder} onClear={selection.clear}
              onAddMore={() => pickers.current?.openFiles()} onUpload={upload.uploadSelection}
            />
            {/* keep the inputs mounted for "Add more" */}
            <HiddenPickers ref={pickers} allowFolders={portal.allowFolders} onPick={upload.onPicked} />
          </>
        )}
      </div>
    );
  }

  const quota = dashboard.data?.quota ?? portal.quota;
  const remaining = quota.limitBytes ? Math.max(0, quota.limitBytes - quota.usedBytes) : null;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-fg sm:text-3xl">Upload files</h1>
        <p className="text-sm text-fg-muted">
          {portal.maxFileSizeBytes ? `Up to ${formatBytes(portal.maxFileSizeBytes)} per file` : 'No size limit per file'}
          {remaining != null && <> · {formatBytes(remaining)} of space left</>}
        </p>
      </div>
      {view === 'select' && <PortalNotes portal={portal} only="instructions" />}
      {body}
      <HiddenPickers ref={addMore} allowFolders={false} onPick={upload.onPicked} />
      {sticky && <div aria-hidden className="h-20 sm:hidden" />}
      {view === 'select' && selection.items.length > 0 && !upload.needsIntakeStep && (
        <MobileUploadBar label={`Upload ${formatBytes(selection.totalBytes)}`} busyLabel={prep?.label} onClick={upload.uploadSelection} />
      )}
      {view === 'uploading' && <MobileProgressBar snapshot={snapshot} onPauseAll={() => manager.pauseAll()} onResumeAll={() => manager.resumeAll()} />}
    </div>
  );
}
