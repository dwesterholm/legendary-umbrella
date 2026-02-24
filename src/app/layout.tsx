import type { Metadata } from "next";
import { DM_Sans } from "next/font/google";
import "./globals.css";

const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Bostad AI",
  description: "AI-driven bostadsanalys for svenska bostadskopare",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="sv" className={dmSans.variable}>
      <body className="font-sans antialiased bg-warm-white text-warm-gray-900">
        {children}
      </body>
    </html>
  );
}
