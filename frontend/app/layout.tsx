import type { Metadata } from "next";
import { Inter, Radley } from "next/font/google";
import "./globals.css";

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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sans.variable} ${radley.variable}`}>
      <body>
        {children}
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-[100]"
          style={{ background: "url(/noise.png)", opacity: 0.012 }}
        />
      </body>
    </html>
  );
}
