import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'ShiftKart for Business', description: 'Post verified, pre-funded short shifts.' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
