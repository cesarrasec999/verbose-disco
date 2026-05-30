"use client";

import { useCallback, useEffect, useState } from "react";
import { Home, LogOut } from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { endSingleDeviceSession, readStoredUser } from "@/lib/singleDeviceSession";
import { canAccessModule } from "@/features/access/moduleAccess";
import { NoInventariablesModule } from "@/features/no-inventariables/NoInventariablesModule";
import { fetchNonInventoryProducts } from "@/features/no-inventariables/api";
import type { CyclicUser, NonInventoryProduct, Product } from "@/features/ciclicos/types";

export default function NoInventariablesPage() {
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [products, setProducts] = useState<NonInventoryProduct[]>([]);
  const [assignResults, setAssignResults] = useState<Product[]>([]);
  const [assignSelectedIds, setAssignSelectedIds] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ text: string; type: "info" | "success" | "error" } | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = readStoredUser<CyclicUser>();
    if (!stored || !canAccessModule(stored, "reports_non_inventory")) {
      window.location.replace("/");
      return;
    }
    setUser(stored);
    fetchNonInventoryProducts(supabase).then(data => {
      setProducts(data);
      setReady(true);
    }).catch(() => setReady(true));
  }, []);

  const showMessage = useCallback((text: string, type: "info" | "success" | "error" = "info") => {
    setMessage({ text, type });
    setTimeout(() => setMessage(null), 4000);
  }, []);

  function handleLogout() {
    if (user) void endSingleDeviceSession(user);
    localStorage.removeItem("cyclic_user");
    window.location.replace("/");
  }

  if (!ready) {
    return (
      <main className="min-h-screen bg-slate-100 flex items-center justify-center">
        <div className="text-slate-500 font-semibold">Cargando...</div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-100">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white border-b shadow-sm px-4 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button onClick={() => window.location.href = "/"} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50" title="Menú principal">
            <Home size={18} />
          </button>
          <div>
            <h1 className="font-bold text-slate-900 text-base">No Inventariables</h1>
            <p className="text-xs text-slate-400">{user?.full_name}</p>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
        >
          <LogOut size={15} />
          Salir
        </button>
      </header>

      {/* Mensaje global */}
      {message && (
        <div className={`mx-4 mt-4 rounded-2xl px-4 py-3 text-sm font-semibold ${
          message.type === "success" ? "bg-green-50 text-green-700 border border-green-200" :
          message.type === "error"   ? "bg-red-50 text-red-700 border border-red-200" :
          "bg-blue-50 text-blue-700 border border-blue-200"
        }`}>
          {message.text}
        </div>
      )}

      {/* Contenido */}
      <div className="p-4 max-w-5xl mx-auto">
        <NoInventariablesModule
          user={user}
          products={products}
          assignResults={assignResults}
          onProductsChange={setProducts}
          onAssignResultsChange={updater => setAssignResults(prev => updater(prev))}
          onAssignSelectedIdsChange={updater => setAssignSelectedIds(prev => updater(prev))}
          showMessage={showMessage}
        />
      </div>

      {/* Suprimir warning de assignSelectedIds no usado */}
      <span className="hidden">{assignSelectedIds.size}</span>
    </main>
  );
}
