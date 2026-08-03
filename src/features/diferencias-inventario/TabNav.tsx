"use client";

import Link from "next/link";
import { ClipboardList, Home, PackagePlus } from "lucide-react";

export function TabNav({ active }: { active: "reportar" | "resumen" }) {
  const tabClass = (isActive: boolean) =>
    `flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-black ${
      isActive ? "bg-slate-900 text-white" : "border bg-white text-slate-600"
    }`;

  return (
    <div className="flex gap-2">
      <Link href="/" className="flex shrink-0 items-center justify-center rounded-xl border bg-white px-3 text-slate-600 hover:bg-slate-50" title="Menú principal" aria-label="Menú principal">
        <Home size={18} />
      </Link>
      <Link href="/diferencias-inventario/reportar" className={tabClass(active === "reportar")}>
        <PackagePlus size={16} /> Reportar
      </Link>
      <Link href="/diferencias-inventario/resumen" className={tabClass(active === "resumen")}>
        <ClipboardList size={16} /> Resumen
      </Link>
    </div>
  );
}
