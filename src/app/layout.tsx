import type { Metadata } from "next";
import type { ReactNode } from "react";
import "../styles/tokens.css";
import "../styles/layout.css";
import "../styles/entries.css";
import "../styles/highlight.css";
import "../styles/toolbar-cleanup.css";
import "../styles/practice.css";
import "../styles/cloud.css";

export const metadata: Metadata = {
  title: "Jiten → Migaku Miner",
  description: "Your private Japanese vocabulary and mining workspace.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
