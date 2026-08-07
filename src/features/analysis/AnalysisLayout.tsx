"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Home, LineChart } from "lucide-react";

const reportLinks = [
  ["stock", "Valorizado stock"],
  ["rotaciones", "Rotaciones"],
  ["ventas", "Ventas y margen"],
  ["presupuesto", "Presupuesto"],
] as const;

export default function AnalysisLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-7xl space-y-4 px-4 pb-0 pt-4 md:px-8 md:pt-8">
        <header className="flex flex-wrap items-center gap-3 rounded-2xl border bg-white p-4 shadow-sm">
          <Link href="/" aria-label="Inicio" className="flex h-10 w-10 items-center justify-center rounded-xl border text-slate-700 hover:bg-slate-50"><Home size={19} /></Link>
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-950 text-white"><LineChart size={19} /></div>
          <div className="mr-auto">
            <p className="text-xs font-black uppercase tracking-wide text-slate-500">Módulo independiente</p>
            <h1 className="text-xl font-black text-slate-950">Análisis</h1>
          </div>
          <Link href="/analisis/eri" className={`rounded-xl px-4 py-2 text-sm font-black ${pathname.startsWith("/analisis/eri") ? "bg-slate-950 text-white" : "border text-slate-700 hover:bg-slate-50"}`}>ERI consolidado</Link>
        </header>
        <nav className="grid grid-cols-2 gap-2 rounded-2xl border bg-white p-2 md:grid-cols-4">
          {reportLinks.map(([key, label]) => {
            const active = pathname === `/analisis/reportes/${key}`;
            return <Link key={key} href={`/analisis/reportes/${key}`} className={`rounded-xl px-3 py-2 text-center text-sm font-black ${active ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-50"}`}>{label}</Link>;
          })}
        </nav>
      </div>
      {children}
    </div>
  );
}
