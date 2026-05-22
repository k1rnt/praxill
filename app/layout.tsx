import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Praxill",
  description: "対話で育てる、自分だけの教科書",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0b0d12",
};

// Apply the user's saved theme as early as possible to avoid a dark/light
// flash. Runs synchronously inside <body> before any React content paints.
// Default is "dark" (matches the original design).
const THEME_BOOT = `
(function(){
  try {
    var t = localStorage.getItem('theme');
    if (t !== 'light' && t !== 'dark') t = 'dark';
    document.documentElement.setAttribute('data-theme', t);
  } catch(_) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
`;

// Defensive shim for wallet-extension injection (Brave Wallet / MetaMask).
// They write to `window.ethereum.selectedAddress` on every page; if their
// own bootstrap left `window.ethereum` undefined we get a Runtime TypeError
// that Next.js dev surfaces as a big red overlay even though nothing in our
// app actually uses ethereum. We:
//   1. Pre-define `window.ethereum` as a no-op Proxy so the setter has a
//      target if the extension runs after this script.
//   2. Install an error listener that swallows anything containing
//      "window.ethereum" or "selectedAddress" so the overlay doesn't open.
const WALLET_SHIM = `
(function(){
  try {
    if (typeof window !== 'undefined' && !('ethereum' in window) && typeof Proxy !== 'undefined') {
      var nullProxy = new Proxy({}, {
        set: function(){ return true; },
        get: function(){ return undefined; },
        has: function(){ return true; },
        deleteProperty: function(){ return true; }
      });
      Object.defineProperty(window, 'ethereum', { value: nullProxy, writable: true, configurable: true });
    }
  } catch(_) {}
  function isWalletErr(msg) {
    return typeof msg === 'string' && /window\\.ethereum|selectedAddress/i.test(msg);
  }
  window.addEventListener('error', function(e){
    if (isWalletErr(e && e.message)) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);
  var prev = window.onerror;
  window.onerror = function(m){ if (isWalletErr(m)) return true; return prev ? prev.apply(this, arguments) : false; };
})();
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
        <script dangerouslySetInnerHTML={{ __html: WALLET_SHIM }} />
        <div className="app-shell">
          <header className="app-header">
            <div className="app-header__inner">
              <div className="app-header__title">
                <Link href="/">🪶 Praxill</Link>
              </div>
              <div className="app-header__spacer" />
              <Link
                className="btn btn--ghost btn--sm"
                href="/search"
                aria-label="検索"
              >
                🔍
              </Link>
              <Link
                className="btn btn--ghost btn--sm"
                href="/settings"
                aria-label="設定"
              >
                ⚙
              </Link>
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
