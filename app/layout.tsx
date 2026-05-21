import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Personal Textbook",
  description: "自分専用のクイズ式教科書",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0d12",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>
        <div className="app-shell">
          <header className="app-header">
            <div className="app-header__inner">
              <div className="app-header__title">
                <Link href="/">📘 Textbook</Link>
              </div>
              <div className="app-header__spacer" />
              <Link className="btn btn--primary btn--sm" href="/topics/new">
                + 新規
              </Link>
            </div>
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
