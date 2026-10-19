import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Photoedit",
  description: "Minimal RAW editor",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-full">{children}</body>
    </html>
  );
}
