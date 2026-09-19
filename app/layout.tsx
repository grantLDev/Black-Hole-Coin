import type { Metadata, Viewport } from "next";
import { TOKEN_NAME, TOKEN_SYMBOL } from "@/config/token";
import "./globals.css";

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
const DESCRIPTION =
  "A black hole that grows with every holder. Market cap is an achievement, not a thermometer — once a tier unlocks, it never unlocks.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${TOKEN_NAME} — $${TOKEN_SYMBOL}`,
    template: `%s — $${TOKEN_SYMBOL}`,
  },
  description: DESCRIPTION,
  applicationName: TOKEN_NAME,
  keywords: [TOKEN_NAME, TOKEN_SYMBOL, "solana", "pump.fun", "black hole", "webgl"],
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: TOKEN_NAME,
    title: `${TOKEN_NAME} — $${TOKEN_SYMBOL}`,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: `${TOKEN_NAME} — $${TOKEN_SYMBOL}`,
    description: DESCRIPTION,
  },
  robots: { index: true, follow: true },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#000000",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // suppressHydrationWarning: extensions that rewrite the page before React
  // loads (Dark Reader and friends) add attributes to <html> and <body>, which
  // React then reports as a hydration mismatch it cannot patch up. The flag is
  // one level deep -- it silences the attribute diff on these two elements and
  // nothing inside them, so a real mismatch in the app still surfaces.
  return (
    <html lang="en" className="bg-black" suppressHydrationWarning>
      <body className="bg-black text-white antialiased" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
