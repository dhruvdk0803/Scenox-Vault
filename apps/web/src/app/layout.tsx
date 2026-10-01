import type { Metadata, Viewport } from 'next';
import { GeistSans } from 'geist/font/sans';
import { GeistMono } from 'geist/font/mono';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Scenox Vault', template: '%s · Scenox Vault' },
  description: 'Secure, self-hosted large file uploads from your clients.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: '#fafafa', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-dvh antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
