import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { MobileTopBar, Sidebar } from "@/components/Sidebar";
import { runtimeLane } from "@/lib/runtime";

export const dynamic = "force-dynamic";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Gini",
  description: "Gini local control plane"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const lane = runtimeLane();
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-background text-foreground">
        <Providers>
          <div className="flex h-screen">
            <Sidebar lane={lane} />
            <div className="flex flex-1 flex-col overflow-hidden">
              <MobileTopBar lane={lane} />
              <main className="flex flex-1 flex-col overflow-hidden">{children}</main>
            </div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
