'use client';

import * as React from 'react';
import { FileDetailsDialog } from '../files/file-details-dialog';
import { MessageThread, type MessageThreadProps } from './message-thread';

/** A portal conversation whose "On file" chips open the file details dialog. */
export function PortalMessageThread(props: Omit<MessageThreadProps, 'onOpenFile'>) {
  const [openFileId, setOpenFileId] = React.useState<string | null>(null);
  return (
    <>
      <MessageThread {...props} onOpenFile={setOpenFileId} />
      <FileDetailsDialog fileId={openFileId} onOpenChange={(o) => !o && setOpenFileId(null)} />
    </>
  );
}
