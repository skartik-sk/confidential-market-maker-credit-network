import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { WalletProvider } from "@/components/WalletProvider";
import { Toaster } from "@/lib/toast";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Mute — Confidential Credit on Solana",
  description: "Confidential operating credit for Solana market makers. Variable-note draws, encrypted risk checks, and private settlement rails.",
  icons: { icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%23fbfbf9' stroke='%23e6e1dc'/><rect x='8' y='8' width='16' height='16' rx='2' fill='%23dc2b28' transform='rotate(45 16 16)'/></svg>" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
      <head>
        {/* Dark mode init — runs before first paint to avoid a flash.
            Stored pref wins; otherwise fall back to the OS preference. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("mute-theme");if(t?t==="dark":window.matchMedia("(prefers-color-scheme: dark)").matches)document.documentElement.classList.add("dark")}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-screen bg-bg text-ink">
        <WalletProvider>
          {children}
          <Toaster />
        </WalletProvider>
      </body>
    </html>
  );
}
