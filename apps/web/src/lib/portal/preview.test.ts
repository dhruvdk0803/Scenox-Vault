import { describe, expect, it } from 'vitest';
import { canThumbnail, previewKind, previewUrl } from './preview';

const f = (type: string, extension: string, status = 'ready') => ({ type, extension, status });

describe('previewKind', () => {
  it('previews browser-friendly types', () => {
    expect(previewKind(f('image', 'jpg'))).toBe('image');
    expect(previewKind(f('image', 'PNG'))).toBe('image');
    expect(previewKind(f('video', 'mp4'))).toBe('video');
    expect(previewKind(f('video', 'mov'))).toBe('video');
    expect(previewKind(f('audio', 'mp3'))).toBe('audio');
    expect(previewKind(f('document', 'pdf'))).toBe('pdf');
    expect(previewKind(f('document', 'txt'))).toBe('text');
  });
  it.each([
    ['image', 'svg'], ['image', 'heic'], ['image', 'cr2'], ['image', 'psd'], ['image', 'tiff'],
    ['video', 'mkv'], ['video', 'avi'], ['document', 'docx'], ['archive', 'zip'], ['other', 'bin'],
  ])('does not preview %s/%s', (t, e) => expect(previewKind(f(t, e))).toBeNull());
  it('needs a ready file', () => {
    expect(previewKind(f('image', 'jpg', 'processing'))).toBeNull();
  });
});

describe('thumbnails & urls', () => {
  it('only thumbnails images up to 25 MB', () => {
    expect(canThumbnail({ ...f('image', 'jpg'), size: 1000 })).toBe(true);
    expect(canThumbnail({ ...f('image', 'jpg'), size: 26 * 1024 * 1024 })).toBe(false);
    expect(canThumbnail({ ...f('video', 'mp4'), size: 1000 })).toBe(false);
  });
  it('builds preview urls with an optional access token', () => {
    expect(previewUrl('tok', 'abc', null)).toBe('/api/public/portals/tok/files/abc/preview');
    expect(previewUrl('tok', 'abc', 'a b')).toBe('/api/public/portals/tok/files/abc/preview?access=a%20b');
  });
});
