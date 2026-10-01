import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: { absolute: 'Secure upload' },
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/** Public client portal: no admin chrome — just the branded page. */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return children;
}
