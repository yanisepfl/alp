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
  title: "alps — onchain market making",
  description:
    "The yield of onchain volume, unlocked. A delta-neutral, agent-managed market-making book, anyone can mint.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sans.variable} ${radley.variable}`}>
      <body>{children}</body>
    </html>
  );
}
