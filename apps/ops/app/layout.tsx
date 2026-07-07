import type { Metadata, Viewport } from 'next';
import './globals.css';
import NavProgress from '@/components/NavProgress';
import AutoRefresh from '@/components/AutoRefresh';

export const metadata: Metadata = {
  title: 'Jigzle Ops',
  description: 'Jigzle operations — sales order entry',
  // PR199: on modern iOS an installed ("Open as Web App") home-screen shortcut takes its icon
  // from the web app manifest, NOT the apple-touch-icon — without a manifest iOS drew the brown
  // letter tile. The manifest's icons point at the Jigzle logo so the installed app uses it.
  manifest: '/manifest.json',
  appleWebApp: { capable: true, title: 'Jigzle Ops', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  themeColor: '#724F33',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover', // so env(safe-area-inset-*) resolves to real iOS notch/home-bar insets
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <NavProgress />
        <AutoRefresh />
        {children}
      </body>
    </html>
  );
}
