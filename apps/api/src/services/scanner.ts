import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import net from 'node:net';

export type ScanResult = { status: 'clean' } | { status: 'infected'; signature: string };

export interface ClamdOptions {
  host: string;
  port: number;
  /** idle socket timeout (ms) — scanning large files can take a while */
  timeoutMs?: number;
  chunkSize?: number;
}

/** Parse a clamd reply such as "stream: OK" or "stream: Eicar-Test-Signature FOUND". Throws on errors. */
export function parseClamdReply(raw: string): ScanResult {
  const reply = raw.replace(/\0/g, '').trim();
  if (/^stream:\s*OK$/i.test(reply)) return { status: 'clean' };
  const found = /^stream:\s*(.+?)\s+FOUND$/i.exec(reply);
  if (found) return { status: 'infected', signature: found[1]! };
  throw new Error(`Unexpected clamd reply: ${reply || '(empty)'}`);
}

/**
 * Scan a file on disk with clamd using the INSTREAM protocol:
 *   "zINSTREAM\0" then [4-byte big-endian length][data] chunks, then a zero-length chunk.
 * The file is streamed in 1 MB chunks; it is never loaded into memory.
 */
export function scanWithClamd(filePath: string, opts: ClamdOptions): Promise<ScanResult> {
  const chunkSize = opts.chunkSize ?? 1024 * 1024;
  return new Promise<ScanResult>((resolve, reject) => {
    const socket = net.createConnection({ host: opts.host, port: opts.port });
    socket.setTimeout(opts.timeoutMs ?? 10 * 60_000);
    let reply = '';
    let settled = false;
    const closed = new Promise<void>((r) => socket.once('close', () => r()));
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    socket.on('data', (d) => {
      reply += d.toString('utf8');
      if (reply.length > 4096) fail(new Error('clamd reply too long'));
    });
    socket.on('timeout', () => fail(new Error('clamd timed out')));
    socket.on('error', fail);
    socket.on('close', () => {
      if (settled) return;
      settled = true;
      try {
        resolve(parseClamdReply(reply));
      } catch (err) {
        reject(err);
      }
    });

    socket.once('connect', () => {
      void (async () => {
        try {
          socket.write('zINSTREAM\0');
          const input = createReadStream(filePath, { highWaterMark: chunkSize });
          for await (const chunk of input as AsyncIterable<Buffer>) {
            if (socket.destroyed) break;
            const len = Buffer.alloc(4);
            len.writeUInt32BE(chunk.length);
            socket.write(len);
            if (!socket.write(chunk)) await Promise.race([once(socket, 'drain'), closed]);
          }
          if (!socket.destroyed) socket.write(Buffer.alloc(4)); // zero-length terminator
        } catch (err) {
          fail(err as Error);
        }
      })();
    });
  });
}
