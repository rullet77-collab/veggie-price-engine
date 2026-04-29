import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
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
  title: "야채 판매가 자동책정 시스템",
  description: "식자재 유통 판매가 자동책정",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ko"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <nav className="bg-white border-b border-gray-200 px-6 py-3 flex items-center gap-6">
          <span className="text-lg font-bold text-gray-900">판매가 자동책정</span>
          <Link
            href="/"
            className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
          >
            대시보드
          </Link>
          <Link
            href="/products"
            className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
          >
            전체상품
          </Link>
          <Link
            href="/upload"
            className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
          >
            업로드
          </Link>
          <Link
            href="/platform"
            className="text-sm text-gray-600 hover:text-gray-900 transition-colors"
          >
            플랫폼 업로드
          </Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
