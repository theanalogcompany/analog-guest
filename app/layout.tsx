import type { Metadata } from "next";
import { Fraunces, Inter_Tight } from "next/font/google";
import "./globals.css";

// Brand fonts. Variable axes match docs/brand/style-guide-v01.html — Fraunces
// gets opsz/SOFT/WONK in addition to the implicit wght/ital; Inter Tight
// stays vanilla variable. The CSS variables exposed here are picked up by
// globals.css's @theme inline block and surface as Tailwind's
// `font-fraunces` / `font-inter-tight` utilities.
const fraunces = Fraunces({
  variable: "--font-fraunces-loaded",
  subsets: ["latin"],
  axes: ["opsz", "SOFT", "WONK"],
  display: "swap",
});

const interTight = Inter_Tight({
  variable: "--font-inter-tight-loaded",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Analog",
  description: "Guest recognition platform.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${interTight.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
