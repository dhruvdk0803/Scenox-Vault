import { fileTypeFromBuffer } from 'file-type';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { badRequest, notFound, payloadTooLarge } from '../lib/errors';
import { getStorage, KEYS } from '../storage';
import { getSettings } from './settings';

const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const ICON_TYPES: Record<string, string> = { ...IMAGE_TYPES, 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico' };
const MIME_BY_EXT: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon' };

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export interface UploadedImage {
  buffer: Buffer;
  ext: string;
  mime: string;
}

/**
 * Read the single multipart `file` field and verify it is a real raster image by magic bytes
 * (the declared filename / content-type are ignored). SVG is deliberately NOT accepted (script injection).
 */
export async function readImageUpload(req: FastifyRequest, opts: { allowIcon?: boolean; maxBytes?: number } = {}): Promise<UploadedImage> {
  const maxBytes = opts.maxBytes ?? MAX_LOGO_BYTES;
  if (!req.isMultipart()) throw badRequest('Upload the image as multipart form data.');
  const tooLarge = () => payloadTooLarge(`The image must be ${Math.round(maxBytes / 1024 / 1024)} MB or smaller.`);
  const part = await req.file({ limits: { fileSize: maxBytes, files: 1 } }).catch((err: { code?: string }) => {
    throw err?.code === 'FST_REQ_FILE_TOO_LARGE' ? tooLarge() : badRequest('The upload could not be read.');
  });
  if (!part) throw badRequest('Choose an image to upload.');
  let buffer: Buffer;
  try {
    buffer = await part.toBuffer();
  } catch (err) {
    throw (err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE' ? tooLarge() : badRequest('The upload could not be read.');
  }
  if (part.file.truncated) throw tooLarge();
  if (buffer.length === 0) throw badRequest('The uploaded file is empty.');
  const detected = await fileTypeFromBuffer(buffer);
  const allowed = opts.allowIcon ? ICON_TYPES : IMAGE_TYPES;
  const ext = detected ? allowed[detected.mime] : undefined;
  if (!detected || !ext) {
    throw badRequest(opts.allowIcon ? 'Use a PNG, JPEG, WebP or ICO image.' : 'Use a PNG, JPEG or WebP image.', { code: 'unsupported_image' });
  }
  return { buffer, ext, mime: MIME_BY_EXT[ext] };
}

/** Store an image under `branding/<prefix>-<random>.<ext>` and return its key. */
export async function storeBrandingImage(prefix: string, img: UploadedImage): Promise<string> {
  const key = `${KEYS.branding}/${prefix}-${randomBytes(8).toString('hex')}.${img.ext}`;
  await getStorage().put(key, img.buffer);
  return key;
}

export async function deleteBrandingKey(key: string | null | undefined) {
  if (!key || !key.startsWith(`${KEYS.branding}/`)) return;
  await getStorage().delete(key).catch(() => {});
}

/** Stream a stored branding image with safe headers. Throws 404 when missing. */
export async function serveStoredImage(key: string | null | undefined, reply: FastifyReply) {
  if (!key || !key.startsWith(`${KEYS.branding}/`)) throw notFound();
  const ext = key.split('.').pop()?.toLowerCase() ?? '';
  const mime = MIME_BY_EXT[ext];
  if (!mime) throw notFound();
  let file: Awaited<ReturnType<ReturnType<typeof getStorage>['get']>>;
  try {
    file = await getStorage().get(key);
  } catch {
    throw notFound();
  }
  return reply
    .header('content-type', mime)
    .header('content-length', file.size)
    .header('cache-control', 'public, max-age=3600')
    .header('x-content-type-options', 'nosniff')
    .header('content-disposition', 'inline')
    .header('cross-origin-resource-policy', 'cross-origin')
    .send(file.stream);
}

/** For GET /api/public/branding/logo and /favicon (wired by the public routes). */
export async function serveBrandingAsset(kind: 'logo' | 'favicon', reply: FastifyReply) {
  const { branding } = await getSettings();
  return serveStoredImage(kind === 'logo' ? branding.logoKey : branding.faviconKey, reply);
}
