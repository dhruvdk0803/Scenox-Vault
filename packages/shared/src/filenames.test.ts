import { describe, expect, it } from 'vitest';
import { getExtension, sanitizeFilename, sanitizeRelativePath, splitRelativeFilePath, withCopySuffix } from './filenames';
import { fileCategory } from './constants';
import { formatBytes, formatDuration } from './format';

describe('sanitizeFilename', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\windows\\system32\\cmd.exe', 'cmd.exe'],
    ['/absolute/path/file.txt', 'file.txt'],
    ['C:\\Users\\x\\file.txt', 'file.txt'],
    ['..', 'unnamed'],
    ['', 'unnamed'],
    ['  .hidden  ', 'hidden'],
    ['a<b>c:d"e|f?g*h.txt', 'a_b_c_d_e_f_g_h.txt'],
    ['nul.txt', '_nul.txt'],
    ['ok\u0000name\u001f.pdf', 'okname.pdf'],
  ])('%s → %s', (input, expected) => expect(sanitizeFilename(input)).toBe(expected));

  it('truncates very long names but keeps the extension', () => {
    const name = sanitizeFilename(`${'a'.repeat(400)}.jpeg`);
    expect(name.length).toBeLessThanOrEqual(255);
    expect(name.endsWith('.jpeg')).toBe(true);
  });
});

describe('sanitizeRelativePath', () => {
  it.each([
    ['products/images', 'products/images'],
    ['../../etc', 'etc'],
    ['/abs/../x/./y', 'abs/x/y'],
    ['C:\\data\\..\\photos', 'data/photos'],
    ['a//b\\\\c', 'a/b/c'],
    ['', ''],
    [null, ''],
  ] as [string | null, string][])('%s → %s', (input, expected) => expect(sanitizeRelativePath(input)).toBe(expected));
});

describe('helpers', () => {
  it('splits webkitRelativePath', () => {
    expect(splitRelativeFilePath('products/images/001.jpg')).toEqual({ dir: 'products/images', name: '001.jpg' });
    expect(splitRelativeFilePath('file.csv')).toEqual({ dir: '', name: 'file.csv' });
  });
  it('extensions & categories', () => {
    expect(getExtension('Archive.TAR.GZ')).toBe('gz');
    expect(getExtension('README')).toBe('');
    expect(fileCategory('MP4')).toBe('video');
    expect(fileCategory('xyz')).toBe('other');
  });
  it('copy suffix', () => {
    expect(withCopySuffix('report.pdf', 2)).toBe('report (2).pdf');
    expect(withCopySuffix('Makefile', 1)).toBe('Makefile (1)');
  });
  it('formats', () => {
    expect(formatBytes(63_100_000_000)).toBe('63.1 GB');
    expect(formatBytes(0)).toBe('0 B');
    expect(formatDuration(692)).toBe('11m 32s');
  });
});
