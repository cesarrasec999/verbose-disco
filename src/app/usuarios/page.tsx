"use client";

import { useCallback, useEffect, useState } from "react";
import { Home, LogOut } from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import { endSingleDeviceSession, readStoredUser } from "@/lib/singleDeviceSession";
import { canAccessModule } from "@/features/access/moduleAccess";
import { fetchDisabledModules, isModuleBlockedForUser } from "@/features/access/moduleFlags";
import ModuleDisabledScreen from "@/features/access/ModuleDisabledScreen";
import { UsersModule } from "@/features/usuarios/UsersModule";
import type { CyclicUser, Store } from "@/features/ciclicos/types";

export default function UsuariosPage() {
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [message, setMessage] = useState<{ text: string; type: "info" | "success" | "error" } | null>(null);
  const [ready, setReady] = useState(false);
  const [moduleDisabled, setModuleDisabled] = useState(false);

  useEffect(() => {
    const stored = readStoredUser<CyclicUser>();
    if (!stored || !canAccessModule(stored, "users")) {
      window.location.replace("/");
      return;
    }
    fetchDisabledModules().then(disabled => {
      if (isModuleBlockedForUser(disabled, "users", stored)) setModuleDisabled(true);
    });
    setUser(stored);
    supabase.from("stores").select("id, code, name, erp_sede, is_active").order("name").then(({ data }) => {
      setStores((data || []) as Store[]);
      setReady(true);
    });
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
  if (moduleDisabled) return <ModuleDisabledScreen moduleLabel="Usuarios" />;

  return (
    <main className="min-h-screen bg-slate-100">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white border-b shadow-sm px-4 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button onClick={() => window.location.href = "/"} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50" title="Menú principal">
            <Home size={18} />
          </button>
          <div>
            <h1 className="font-bold text-slate-900 text-base">Gestión de Usuarios</h1>
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
        <UsersModule stores={stores} showMessage={showMessage} />
      </div>
    </main>
  );
}
