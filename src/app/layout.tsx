import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Savings Goals",
  description:
    "Track savings toward specific goals with a thermometer for each — deposits, pace projections, deadlines, and lump-sum allocation.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const isDev = process.env.JARVIS_ENV === "dev";
  return (
    <html lang="en">
      <body>
        {isDev && (
          <div className="env-banner">Development · this is the dev site</div>
        )}
        {children}
      </body>
    </html>
  );
}
