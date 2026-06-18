import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Jigzle Ops',
  description: 'Jigzle operations — sales order entry',
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
      <body>{children}</body>
    </html>
  );
}
