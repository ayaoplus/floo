import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Nav } from "@/components/nav";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Floo Monitor",
  description: "Multi-Agent Vibe Coding Harness — Monitoring Dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-parchment text-near-black">
        <Nav />
        <main className="flex-1">{children}</main>
        <footer className="border-t border-border-cream py-4 text-center text-xs text-stone-gray">
          Floo v0.1.0
        </footer>
      </body>
    </html>
  );
}
