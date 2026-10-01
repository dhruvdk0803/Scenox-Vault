/**
 * Filename / path sanitisation shared by client and server.
 * The server ALWAYS re-sanitises; client-side use is for display only.
 * Stored files never use these names on disk — disk keys are generated UUIDs.
 */

const RESERVED_WIN = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
const ILLEGAL = /[<>:"|?*\\]/g;
const MAX_SEGMENT = 255;
const MAX_DEPTH = 32;

export function sanitizeSegment(input: string): string {
  let s = (input ?? '').normalize('NFC').replace(CONTROL, '').replace(ILLEGAL, '_').trim();
  // strip leading/trailing dots & spaces (Windows) and collapse traversal tokens
  s = s.replace(/^[.\s]+|[.\s]+$/g, '');
  if (s === '' || s === '.' || s === '..') return '';
  if (RESERVED_WIN.test(s)) s = `_${s}`;
  if (s.length > MAX_SEGMENT) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : '';
    s = s.slice(0, MAX_SEGMENT - ext.length) + ext;
  }
  return s;
}

/** Sanitise a filename (no directory components allowed). */
export function sanitizeFilename(input: string): string {
  const base = (input ?? '').split(/[\\/]/).pop() ?? '';
  return sanitizeSegment(base) || 'unnamed';
}

/**
 * Sanitise a relative folder path such as "products/images".
 * Removes absolute prefixes, drive letters, "..", empty segments. Returns '' for root.
 */
export function sanitizeRelativePath(input: string | null | undefined): string {
  if (!input) return '';
  const parts = input
    .replace(/^[a-zA-Z]:/, '')
    .split(/[\\/]+/)
    .map(sanitizeSegment)
    .filter((p) => p !== '');
  return parts.slice(0, MAX_DEPTH).join('/');
}

export function getExtension(filename: string): string {
  const name = sanitizeFilename(filename);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/** Split a browser-supplied "folder/sub/file.txt" (webkitRelativePath) into dir + name. */
export function splitRelativeFilePath(fullPath: string): { dir: string; name: string } {
  const clean = (fullPath ?? '').replace(/\\/g, '/');
  const idx = clean.lastIndexOf('/');
  if (idx === -1) return { dir: '', name: sanitizeFilename(clean) };
  return { dir: sanitizeRelativePath(clean.slice(0, idx)), name: sanitizeFilename(clean.slice(idx + 1)) };
}

/** "report.pdf" → "report (1).pdf" */
export function withCopySuffix(filename: string, n: number): string {
  const dot = filename.lastIndexOf('.');
  if (dot <= 0) return `${filename} (${n})`;
  return `${filename.slice(0, dot)} (${n})${filename.slice(dot)}`;
}
