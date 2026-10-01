import type { DuplicateAction } from '@scenox/shared';
import type { ErrorKind } from './errors';

export type UploadItemStatus = 'queued' | 'uploading' | 'paused' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface UploadFileSnapshot {
  readonly id: string;
  readonly name: string;
  /** Folder part only; '' for root. */
  readonly relativePath: string;
  readonly size: number;
  readonly status: UploadItemStatus;
  readonly bytesUploaded: number;
  /** 0..100 */
  readonly progress: number;
  /** Smoothed current speed (bytes/s); 0 unless uploading. */
  readonly speed: number;
  readonly avgSpeed: number;
  readonly etaSeconds: number | null;
  /** Hard error shown for failed files. */
  readonly error: string | null;
  readonly errorKind: ErrorKind | null;
  /** Soft notice while tus is retrying automatically. */
  readonly warning: string | null;
  /** True while a failed file is waiting for an automatic retry. */
  readonly autoRetrying: boolean;
  /** Why a paused file is paused. */
  readonly pausedBy: 'user' | 'global' | 'offline' | null;
}

export interface UploadStats {
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly bytesUploaded: number;
  /** 0..100 over non-cancelled bytes. */
  readonly percent: number;
  readonly completedFiles: number;
  readonly completedBytes: number;
  readonly failedFiles: number;
  readonly cancelledFiles: number;
  readonly activeFiles: number; // uploading + processing
  readonly queuedFiles: number;
  readonly pausedFiles: number;
  /** Smoothed overall speed, bytes/s. */
  readonly speed: number;
  readonly avgSpeed: number;
  readonly etaSeconds: number | null;
  /** Anything still in flight or waiting (queued/uploading/processing/paused/auto-retry-pending). */
  readonly running: boolean;
  /** Has items and nothing left to do. */
  readonly finished: boolean;
}

export interface UploadSnapshot {
  readonly version: number;
  readonly items: readonly UploadFileSnapshot[];
  readonly stats: UploadStats;
  readonly offline: boolean;
  readonly paused: boolean;
  readonly sessionExpired: boolean;
  readonly concurrency: { readonly current: number; readonly max: number };
  /** Increments each time a new batch of work starts after the queue had drained. */
  readonly runId: number;
}

export interface AddInput {
  file: File;
  /** Folder part only (use splitRelativeFilePath). */
  relativePath: string;
  name?: string;
  duplicateAction?: Extract<DuplicateAction, 'replace' | 'keep_both'>;
  clientKey?: string;
}

export interface UploadSession {
  sessionId: string;
  sessionToken: string;
}
