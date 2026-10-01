export const HEX_RE = /^#([0-9a-fA-F]{6})$/;

/** Returns "#ffffff" or "#18181b", whichever reads better on the given background hex. */
export function readableTextColor(hex: string): string {
  const m = HEX_RE.exec(hex);
  if (!m) return '#ffffff';
  const n = parseInt(m[1]!, 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  // WCAG: pick the colour with the higher contrast ratio.
  return (L + 0.05) / 0.05 > 1.05 / (L + 0.05) ? '#18181b' : '#ffffff';
}
