import type { Metadata } from "next";
import { Fraunces, Inter, IBM_Plex_Mono, Noto_Sans_Bengali } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { AuthProvider } from "@/components/auth/AuthProvider";
import { AiLanguageProvider } from "@/components/ai/AiLanguageProvider";
import { AllVideosProvider } from "@/components/video/AllVideosProvider";
import { TourProvider } from "@/components/tour/TourProvider";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "sonner";

const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-display", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
// Bengali glyphs: Inter has none, so Bangla AI output would fall back to an arbitrary system font.
const notoSansBengali = Noto_Sans_Bengali({ subsets: ["bengali", "latin"], variable: "--font-bn", display: "swap" });
const plexMono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Study Lamp — Learning Video Organizer",
  description: "Organize, watch, and track progress across your learning video library.",
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
    apple: "/icon.svg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${fraunces.variable} ${inter.variable} ${notoSansBengali.variable} ${plexMono.variable} font-sans`}
        suppressHydrationWarning
      >
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <TooltipProvider delayDuration={200}>
            <AuthProvider>
              <AiLanguageProvider>
                <AllVideosProvider>
                  <TourProvider>
                    {children}
                    <Toaster richColors position="top-right" />
                  </TourProvider>
                </AllVideosProvider>
              </AiLanguageProvider>
            </AuthProvider>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
