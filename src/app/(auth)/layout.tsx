import Link from "next/link";
import { Sparkles } from "lucide-react";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <div className="p-6">
        <Link href="/" className="inline-flex items-center gap-2.5">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-gradient-to-br from-gold-400 to-gold-600 shadow-md shadow-gold-500/20">
            <Sparkles className="size-4 text-white" />
          </div>
          <span className="font-bold text-sm tracking-tight">Hilbras Studio</span>
        </Link>
      </div>
      <main className="flex-1 flex items-center justify-center p-6">
        {children}
      </main>
    </div>
  );
}