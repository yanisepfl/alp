import type { Metadata } from "next";
import { headers } from "next/headers";
import { Inter, Radley } from "next/font/google";
import "./globals.css";
import { PersistentBackdrop } from "@/components/persistent-backdrop";
import { Web3Provider } from "@/components/web3-provider";
import { ToastViewport } from "@/lib/toast";

const sans = Inter({
  subsets: ["latin"],
  variable: "--sans-stack",
  display: "swap",
});

const radley = Radley({
  subsets: ["latin"],
  variable: "--font-radley",
  display: "swap",
  weight: ["400"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "alps",
  description: "An onchain basket vault.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookies = (await headers()).get("cookie");
  return (
    <html lang="en" className={`${sans.variable} ${radley.variable}`}>
      <body>
        {/* Skip the entry animations on subsequent loads. Inlined as
            the first body node so it runs before React hydrates — a
            script-injected <style> in <head> sits outside React's
            tree, so hydration can't strip it. Clear the
            `alp:intro-played` localStorage key to re-watch the intro. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{if(localStorage.getItem('alp:intro-played')==='1'){var s=document.createElement('style');s.id='alp-skip-intro';s.textContent='.settle,.lift,.reveal{animation:none!important}';document.head.appendChild(s);}}catch(e){}",
          }}
        />
        {/* Shared landscape backdrop at the panel rect — keeps the bg
            from reloading on landing → /app navigation. */}
        <PersistentBackdrop />
        <Web3Provider cookies={cookies}>{children}</Web3Provider>
        <ToastViewport />
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-[100]"
          style={{ background: "url(/noise.png)", opacity: 0.012 }}
        />
      </body>
    </html>
  );
}
