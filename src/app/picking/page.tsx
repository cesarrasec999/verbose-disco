"use client";

import { useEffect, useState } from "react";
import { Home, PackageSearch } from "lucide-react";

type CyclicUser = {
  full_name: string;
  role: string;
  module_access?: string[] | null;
};

function canAccessPicking(user: CyclicUser) {
  if (Array.isArray(user.module_access) && user.module_access.length > 0) {
    return user.module_access.includes("picking");
  }
  return user.role === "Administrador" || user.role === "Supervisor" || user.role === "Validador";
}

export default function PickingPage() {
  const [user, setUser] = useState<CyclicUser | null>(null);

  useEffect(() => {
    const raw = localStorage.getItem("cyclic_user");
    if (!raw) {
      window.location.replace("/");
      return;
    }
    const parsed = JSON.parse(raw) as CyclicUser;
    if (!canAccessPicking(parsed)) {
      window.location.replace("/");
      return;
    }
    const timer = window.setTimeout(() => setUser(parsed), 0);
    return () => window.clearTimeout(timer);
  }, []);

  if (!user) {
    return <main className="min-h-screen bg-slate-100 p-6 text-slate-700">Validando acceso...</main>;
  }

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900">
      <header className="border-b bg-white px-4 py-3">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              onClick={() => window.location.href = "/"}
              className="rounded-xl border px-3 py-2 text-sm font-bold text-slate-700 hover:bg-slate-50"
              title="Menu principal"
            >
              <Home size={16} />
            </button>
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-600 text-white">
              <PackageSearch size={24} />
            </div>
            <div>
              <h1 className="text-lg font-black">Picking</h1>
              <p className="text-xs font-semibold text-slate-500">Modulo en preparacion</p>
            </div>
          </div>
          <span className="rounded-full border bg-slate-50 px-3 py-1 text-xs font-bold text-slate-600">
            {user.full_name}
          </span>
        </div>
      </header>

      <section className="mx-auto flex min-h-[70vh] max-w-5xl items-center justify-center p-6">
        <div className="w-full max-w-md rounded-3xl border bg-white p-8 text-center shadow-sm">
          <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-3xl bg-violet-600 text-white">
            <PackageSearch size={42} />
          </div>
          <h2 className="mt-5 text-2xl font-black">Picking</h2>
          <p className="mt-2 text-sm font-semibold text-slate-500">
            El acceso ya esta creado. Dejamos el modulo vacio hasta definir el flujo operativo.
          </p>
        </div>
      </section>
    </main>
  );
}
