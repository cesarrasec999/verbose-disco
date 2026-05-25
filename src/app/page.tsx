"use client";

import { useEffect, useMemo, useState } from "react";
import { Boxes, ClipboardCheck, Forklift, ScanLine, ShieldCheck, Tags, Warehouse } from "lucide-react";
import { supabase } from "@/lib/supabase/client";

type CyclicUser = {
  id: string;
  username: string;
  password?: string;
  full_name: string;
  role: string;
  store_id: string | null;
  can_access_all_stores: boolean;
  can_access_audit?: boolean;
  module_access?: string[] | null;
  is_active: boolean;
  whatsapp?: string | null;
};

type InventoryOperator = {
  id: string;
  full_name: string;
  phone: string;
};

type InventorySession = {
  id: string;
  name: string;
  status: string;
  store_name?: string;
};

type InventorySessionRow = {
  id: string;
  name: string;
  status: string;
  stores?: { name?: string | null } | null;
};

type OperatorSessionRow = {
  session_id: string;
  general_inventory_sessions?: { id?: string; status?: string } | null;
};

type LoginDestination = "/dashboard" | "/auditoria" | "/inventarios" | "/picking" | "/abastecimiento" | "/etiquetado-packing";
type InventoryAuthMode = "login" | "register";
type ModuleAccessKey = "cyclic" | "audit" | "general_inventory" | "picking" | "packing" | "replenishment";

const GENERAL_INVENTORY_SESSION_KEY = "general_inventory_session_id";

const MODULES: Array<{
  label: string;
  description: string;
  destination: LoginDestination;
  icon: typeof ClipboardCheck;
  accent: string;
}> = [
  { label: "Conteo Ciclico", description: "Conteos por tienda y validacion diaria", destination: "/dashboard", icon: ClipboardCheck, accent: "bg-blue-600" },
  { label: "Auditorias", description: "Revision y control de auditorias", destination: "/auditoria", icon: ShieldCheck, accent: "bg-amber-500" },
  { label: "Inventario General", description: "Conteo por ubicaciones y reconteos", destination: "/inventarios", icon: Warehouse, accent: "bg-emerald-600" },
  { label: "Picking", description: "Modulo en preparacion", destination: "/picking", icon: ScanLine, accent: "bg-violet-600" },
  { label: "Etiquetado/Packing", description: "Marcar productos para etiquetar o armar", destination: "/etiquetado-packing", icon: Tags, accent: "bg-cyan-600" },
  { label: "Abastecimiento", description: "Seguimiento de solicitudes y recepcion", destination: "/abastecimiento", icon: Forklift, accent: "bg-orange-600" },
];

const DESTINATION_MODULE: Record<LoginDestination, ModuleAccessKey> = {
  "/dashboard": "cyclic",
  "/auditoria": "audit",
  "/inventarios": "general_inventory",
  "/picking": "picking",
  "/etiquetado-packing": "packing",
  "/abastecimiento": "replenishment",
};

function legacyModuleAccess(user: CyclicUser): ModuleAccessKey[] {
  if (user.role === "Administrador") return ["cyclic", "audit", "general_inventory", "picking", "packing", "replenishment"];
  if (user.role === "Supervisor") return ["cyclic", "audit", "general_inventory", "picking", "packing"];
  if (user.role === "Validador") return ["cyclic", "audit", "general_inventory", "picking", "packing"];
  return ["cyclic", "packing"];
}

function userModuleAccess(user: CyclicUser): ModuleAccessKey[] {
  return Array.isArray(user.module_access) && user.module_access.length > 0
    ? user.module_access.filter(Boolean) as ModuleAccessKey[]
    : legacyModuleAccess(user);
}

function hasExplicitModuleAccess(user: CyclicUser) {
  return Array.isArray(user.module_access) && user.module_access.length > 0;
}

function normalizePhone(value: string) {
  return value.replace(/\D/g, "");
}

export default function LoginPage() {
  const [selectedModule, setSelectedModule] = useState<(typeof MODULES)[number] | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [inventoryMode, setInventoryMode] = useState<InventoryAuthMode>("login");
  const [inventoryFullName, setInventoryFullName] = useState("");
  const [inventorySessions, setInventorySessions] = useState<InventorySession[]>([]);
  const [selectedInventorySessionId, setSelectedInventorySessionId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const [pendingUser, setPendingUser] = useState<CyclicUser | null>(null);
  const [modalMode, setModalMode] = useState<"whatsapp" | "changepass" | null>(null);
  const [wspInput, setWspInput] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [newWspInput, setNewWspInput] = useState("");
  const [modalError, setModalError] = useState("");
  const [modalLoading, setModalLoading] = useState(false);

  const destination = selectedModule?.destination || "/dashboard";
  const selectedTitle = selectedModule?.label || "RASECORP";
  const SelectedIcon = selectedModule?.icon || Boxes;

  const loginPlaceholder = useMemo(() => (
    destination === "/inventarios" && inventoryMode !== "register" ? "ID / usuario o celular" : "ID / usuario"
  ), [destination, inventoryMode]);

  function canEnterDestination(user: CyclicUser) {
    const moduleKey = DESTINATION_MODULE[destination];
    if (moduleKey && !userModuleAccess(user).includes(moduleKey)) return false;
    if (hasExplicitModuleAccess(user)) return true;
    if (destination === "/auditoria") return user.role === "Administrador" || user.role === "Supervisor" || user.role === "Validador" || user.can_access_audit;
    if (destination === "/inventarios") return user.role === "Administrador" || user.role === "Validador" || user.role === "Supervisor";
    if (destination === "/picking") return user.role === "Administrador" || user.role === "Validador" || user.role === "Supervisor";
    return true;
  }

  function enterSelectedDestination(user: CyclicUser) {
    if (!canEnterDestination(user)) {
      setError("Tu usuario no tiene acceso a este modulo.");
      return false;
    }
    localStorage.setItem("cyclic_user", JSON.stringify(user));
    window.location.href = destination;
    return true;
  }

  function enterInventory(operator: InventoryOperator, sessionId: string) {
    localStorage.removeItem("cyclic_user");
    localStorage.setItem("general_inventory_operator", JSON.stringify(operator));
    localStorage.setItem(GENERAL_INVENTORY_SESSION_KEY, sessionId);
    window.location.href = "/inventarios";
  }

  async function loadInventorySessions() {
    const { data } = await supabase
      .from("general_inventory_sessions")
      .select("id,name,status,stores(name)")
      .in("status", ["open", "frozen"])
      .order("created_at", { ascending: false });
    const rows = ((data || []) as InventorySessionRow[]).map(row => ({
      id: row.id,
      name: row.name,
      status: row.status,
      store_name: row.stores?.name || "",
    })) as InventorySession[];
    setInventorySessions(rows);
    setSelectedInventorySessionId(prev => prev || rows[0]?.id || "");
  }

  useEffect(() => {
    if (destination !== "/inventarios") return;
    const timer = window.setTimeout(() => void loadInventorySessions(), 0);
    return () => window.clearTimeout(timer);
  }, [destination]);

  async function findOperatorInventorySession(operatorId: string) {
    const preferredSessionId = selectedInventorySessionId || localStorage.getItem(GENERAL_INVENTORY_SESSION_KEY) || "";
    const { data } = await supabase
      .from("general_inventory_session_operators")
      .select("session_id,status,joined_at,general_inventory_sessions(id,status)")
      .eq("operator_id", operatorId)
      .eq("status", "active")
      .order("joined_at", { ascending: false });
    const rows = ((data || []) as OperatorSessionRow[]).filter(row => ["open", "frozen"].includes(row.general_inventory_sessions?.status || ""));
    const preferred = rows.find(row => row.session_id === preferredSessionId);
    return preferred?.session_id || rows[0]?.session_id || "";
  }

  async function handleInventoryAuth() {
    const phone = normalizePhone(username);
    const pass = password.trim();
    setError("");

    if (phone.length < 8 || pass.length < 4) {
      setError("Ingresa celular y clave de al menos 4 caracteres.");
      return;
    }

    setLoading(true);

    if (inventoryMode === "register") {
      if (!inventoryFullName.trim()) {
        setError("Ingresa tus nombres completos.");
        setLoading(false);
        return;
      }
      if (!selectedInventorySessionId) {
        setError("Selecciona el inventario general activo.");
        setLoading(false);
        return;
      }

      const existing = await supabase
        .from("general_inventory_operators")
        .select("id,full_name,phone")
        .eq("phone", phone)
        .maybeSingle();

      let operatorData: InventoryOperator | null = null;
      if (existing.data) {
        const updated = await supabase
          .from("general_inventory_operators")
          .update({ full_name: inventoryFullName.trim(), password: pass })
          .eq("id", existing.data.id)
          .select("id,full_name,phone")
          .single();
        if (updated.error || !updated.data) {
          setError("No se pudo actualizar el operador existente.");
          setLoading(false);
          return;
        }
        operatorData = updated.data as InventoryOperator;
      } else {
        const created = await supabase
          .from("general_inventory_operators")
          .insert({ full_name: inventoryFullName.trim(), phone, password: pass })
          .select("id,full_name,phone")
          .single();
        if (created.error || !created.data) {
          setError("No se pudo registrar operador.");
          setLoading(false);
          return;
        }
        operatorData = created.data as InventoryOperator;
      }

      const join = await supabase
        .from("general_inventory_session_operators")
        .upsert({ session_id: selectedInventorySessionId, operator_id: operatorData.id, status: "active" }, { onConflict: "session_id,operator_id" });
      setLoading(false);
      if (join.error) {
        setError("No se pudo asociar el operador al inventario seleccionado.");
        return;
      }
      enterInventory(operatorData, selectedInventorySessionId);
      return;
    }

    const { data, error: dbError } = await supabase
      .from("general_inventory_operators")
      .select("id,full_name,phone")
      .eq("phone", phone)
      .eq("password", pass)
      .maybeSingle();

    setLoading(false);
    if (dbError || !data) {
      setError("Celular o clave incorrectos.");
      return;
    }
    const sessionId = await findOperatorInventorySession((data as InventoryOperator).id);
    if (!sessionId) {
      setError("No tienes un inventario activo asociado. Pide al validador que te registre.");
      return;
    }
    enterInventory(data as InventoryOperator, sessionId);
  }

  async function handleLogin() {
    if (!selectedModule) {
      setError("Selecciona un modulo para continuar.");
      return;
    }

    if (destination === "/inventarios") {
      const cyclic = await supabase
        .from("cyclic_users")
        .select("*")
        .eq("username", username.trim().toLowerCase())
        .eq("password", password)
        .eq("is_active", true)
        .maybeSingle();
      if (cyclic.data) {
        const user = cyclic.data as CyclicUser;
        if (!canEnterDestination(user)) {
          setError("Tu usuario no tiene acceso a este modulo.");
          return;
        }
        enterSelectedDestination(user);
        return;
      }
      await handleInventoryAuth();
      return;
    }

    setLoading(true);
    setError("");
    const { data, error: dbError } = await supabase
      .from("cyclic_users")
      .select("*")
      .eq("username", username.trim().toLowerCase())
      .eq("password", password)
      .eq("is_active", true)
      .maybeSingle();

    if (dbError || !data) {
      setError("Usuario o clave incorrectos.");
      setLoading(false);
      return;
    }

    const user = data as CyclicUser;
    if (!canEnterDestination(user)) {
      setError("Tu usuario no tiene acceso a este modulo.");
      setLoading(false);
      return;
    }

    if (!user.whatsapp) {
      setPendingUser(user);
      setModalMode("whatsapp");
      setLoading(false);
      return;
    }

    enterSelectedDestination(user);
  }

  async function handleSaveWhatsapp() {
    if (!pendingUser) return;
    setModalError("");
    const wsp = normalizePhone(wspInput);
    if (!wsp || wsp.length < 10) {
      setModalError("Ingresa un numero valido con codigo de pais.");
      return;
    }
    setModalLoading(true);
    const { error: upErr } = await supabase.from("cyclic_users").update({ whatsapp: wsp }).eq("id", pendingUser.id);
    setModalLoading(false);
    if (upErr) {
      setModalError("Error al guardar el numero. Intenta de nuevo.");
      return;
    }
    enterSelectedDestination({ ...pendingUser, whatsapp: wsp });
  }

  async function handleChangePassword() {
    if (!pendingUser) return;
    setModalError("");
    if (!newPass || newPass.length < 4) {
      setModalError("La clave debe tener al menos 4 caracteres.");
      return;
    }
    if (newPass !== confirmPass) {
      setModalError("Las claves no coinciden.");
      return;
    }
    const wsp = normalizePhone(newWspInput);
    const updateData: Record<string, string> = { password: newPass };
    if (wsp) updateData.whatsapp = wsp;
    setModalLoading(true);
    const { error: upErr } = await supabase.from("cyclic_users").update(updateData).eq("id", pendingUser.id);
    setModalLoading(false);
    if (upErr) {
      setModalError("Error al actualizar. Intenta de nuevo.");
      return;
    }
    enterSelectedDestination({ ...pendingUser, password: newPass, whatsapp: wsp || pendingUser.whatsapp });
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-[#07182d] px-4 py-6 text-slate-900">
      <div className="absolute inset-0 opacity-80">
        <div className="rasecorp-login-sweep absolute inset-0" />
        <div className="rasecorp-login-warehouse absolute inset-0" />
        <div className="rasecorp-login-grid absolute inset-0" />
        <div className="rasecorp-login-watermark absolute left-[-10%] top-[9%] hidden w-[120%] select-none whitespace-nowrap text-[11px] font-black uppercase tracking-[0.42em] text-white/18 md:block">
          RASECORP · SOLUCIONES LOGISTICAS · INVENTARIOS · CICLICOS · AUDITORIAS · PICKING · ABASTECIMIENTO · WTSP 980683349 · FB RASECORP · IG RASECORP · GMAIL RASECOR
        </div>
        <div className="absolute bottom-8 left-1/2 hidden -translate-x-1/2 select-none rounded-2xl border border-white/10 bg-slate-950/20 px-5 py-3 text-center text-xs font-bold uppercase tracking-[0.32em] text-white/35 backdrop-blur-sm lg:block">
          RASECORP · WTSP 980683349 · FB RaseCorp · IG RaseCorp · Gmail Rasecor
        </div>
        <div className="absolute bottom-[-110px] right-[-80px] h-[420px] w-[420px] rounded-[72px] border border-orange-500/20 bg-[#0c2744]/40 rotate-12" />
        <img
          src="/icon.png"
          alt=""
          className="absolute right-[8%] top-[12%] h-44 w-44 opacity-10 blur-[1px] sm:h-56 sm:w-56"
        />
      </div>

      <style jsx>{`
        .rasecorp-login-sweep {
          background:
            linear-gradient(120deg, rgba(255, 88, 0, 0.20), transparent 28%, rgba(18, 84, 160, 0.20) 54%, transparent 78%),
            radial-gradient(circle at 20% 22%, rgba(255, 88, 0, 0.18), transparent 28%),
            linear-gradient(145deg, #07182d 0%, #0b2542 50%, #101827 100%);
          background-size: 180% 180%;
          animation: rasecorpSweep 14s ease-in-out infinite alternate;
        }
        .rasecorp-login-grid {
          background-image:
            linear-gradient(rgba(255,255,255,0.07) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px);
          background-size: 56px 56px;
          mask-image: linear-gradient(to bottom, rgba(0,0,0,0.75), rgba(0,0,0,0.18));
          animation: rasecorpGrid 22s linear infinite;
        }
        .rasecorp-login-warehouse {
          opacity: 0.30;
          background:
            linear-gradient(to top, rgba(5, 16, 30, 0.95) 0 18%, transparent 18%),
            repeating-linear-gradient(90deg, transparent 0 6%, rgba(255,255,255,0.13) 6.2% 6.6%, transparent 6.8% 12%),
            repeating-linear-gradient(0deg, transparent 0 15%, rgba(255,255,255,0.10) 15.2% 15.8%, transparent 16% 30%),
            linear-gradient(115deg, transparent 0 28%, rgba(255, 88, 0, 0.24) 28.3% 29%, transparent 29.4% 100%);
          clip-path: polygon(0 24%, 18% 18%, 40% 25%, 60% 16%, 82% 22%, 100% 17%, 100% 100%, 0 100%);
          animation: rasecorpWarehouse 18s ease-in-out infinite alternate;
        }
        .rasecorp-login-watermark {
          animation: rasecorpTextDrift 28s linear infinite;
        }
        @keyframes rasecorpSweep {
          from { background-position: 0% 50%; }
          to { background-position: 100% 50%; }
        }
        @keyframes rasecorpGrid {
          from { transform: translate3d(0, 0, 0); }
          to { transform: translate3d(56px, 56px, 0); }
        }
        @keyframes rasecorpWarehouse {
          from { transform: translate3d(-16px, 0, 0) scale(1.02); }
          to { transform: translate3d(16px, -8px, 0) scale(1.04); }
        }
        @keyframes rasecorpTextDrift {
          from { transform: translateX(0); }
          to { transform: translateX(-18%); }
        }
      `}</style>

      <div className="relative z-10 mx-auto grid min-h-[calc(100vh-48px)] max-w-6xl items-center gap-6 lg:grid-cols-[1.15fr_420px]">
        <section className="space-y-5">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-600 text-xl font-black text-white shadow-lg shadow-orange-950/40">R</div>
            <div>
              <h1 className="text-2xl font-black text-white">RASECORP</h1>
              <p className="text-sm font-semibold text-slate-300">Selecciona un modulo para iniciar</p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {MODULES.map(module => {
              const Icon = module.icon;
              const isActive = selectedModule?.destination === module.destination;
              return (
                <button
                  key={module.destination}
                  onClick={() => {
                    setSelectedModule(module);
                    setError("");
                    setInventoryMode("login");
                  }}
                  className={`group flex min-h-[112px] items-center gap-4 rounded-2xl border p-4 text-left shadow-xl shadow-slate-950/20 backdrop-blur-md transition ${
                    isActive
                      ? "border-orange-400 bg-white ring-2 ring-orange-400"
                      : "border-white/25 bg-white/92 hover:border-orange-300 hover:bg-white"
                  }`}
                >
                  <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-white ${module.accent}`}>
                    <Icon size={24} />
                  </span>
                  <span>
                    <span className="block text-base font-black text-slate-950">{module.label}</span>
                    <span className="mt-1 block text-sm font-semibold text-slate-500">{module.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="rounded-3xl border border-white/25 bg-white/95 p-5 shadow-2xl shadow-slate-950/40 backdrop-blur-md">
          {!selectedModule ? (
            <div className="flex min-h-[420px] flex-col items-center justify-center text-center">
              <Boxes size={48} className="text-slate-300" />
              <p className="mt-4 text-lg font-black">Elige un modulo</p>
              <p className="mt-1 text-sm font-semibold text-slate-500">Luego ingresa tu ID y clave.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <button className="text-sm font-black text-slate-500 hover:text-slate-900" onClick={() => setSelectedModule(null)}>
                Volver a modulos
              </button>
              <div className="flex items-center gap-3">
                <div className={`flex h-12 w-12 items-center justify-center rounded-2xl text-white ${selectedModule.accent}`}>
                  <SelectedIcon size={24} />
                </div>
                <div>
                  <h2 className="text-xl font-black">{selectedTitle}</h2>
                  <p className="text-xs font-semibold text-slate-500">Ingresa tus credenciales para continuar</p>
                </div>
              </div>

              {destination === "/inventarios" && (
                <div className="grid grid-cols-2 gap-2 rounded-2xl border p-1">
                  <button onClick={() => setInventoryMode("login")} className={`rounded-xl px-3 py-2 text-sm font-black ${inventoryMode === "login" ? "bg-slate-900 text-white" : "text-slate-600"}`}>Iniciar sesion</button>
                  <button onClick={() => setInventoryMode("register")} className={`rounded-xl px-3 py-2 text-sm font-black ${inventoryMode === "register" ? "bg-slate-900 text-white" : "text-slate-600"}`}>Auto registro</button>
                </div>
              )}

              {error && <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</div>}

              {destination === "/inventarios" && inventoryMode === "register" && (
                <input
                  className="w-full rounded-2xl border px-4 py-3 text-sm font-semibold outline-none focus:border-slate-900"
                  placeholder="Nombres completos"
                  value={inventoryFullName}
                  onChange={event => setInventoryFullName(event.target.value)}
                />
              )}

              <input
                className="w-full rounded-2xl border px-4 py-3 text-sm font-semibold outline-none focus:border-slate-900"
                placeholder={loginPlaceholder}
                value={username}
                onChange={event => setUsername(event.target.value)}
                autoFocus
              />

              <div className="relative">
                <input
                  className="w-full rounded-2xl border px-4 py-3 pr-16 text-sm font-semibold outline-none focus:border-slate-900"
                  placeholder="Clave"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  onKeyDown={event => { if (event.key === "Enter") void handleLogin(); }}
                />
                <button type="button" onClick={() => setShowPassword(prev => !prev)} className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-black text-slate-500">
                  {showPassword ? "Ocultar" : "Ver"}
                </button>
              </div>

              {destination === "/inventarios" && inventoryMode === "register" && (
                <select
                  className="w-full rounded-2xl border px-4 py-3 text-sm font-semibold outline-none focus:border-slate-900"
                  value={selectedInventorySessionId}
                  onChange={event => setSelectedInventorySessionId(event.target.value)}
                >
                  {inventorySessions.length === 0 && <option value="">Sin inventarios activos</option>}
                  {inventorySessions.map(session => (
                    <option key={session.id} value={session.id}>{session.store_name || session.name} - {session.name}</option>
                  ))}
                </select>
              )}

              {destination !== "/inventarios" && (
                <button
                  type="button"
                  className="text-xs font-bold text-slate-500 underline"
                  onClick={() => {
                    if (!username.trim() || !password) {
                      setError("Ingresa ID y clave primero para cambiarla.");
                      return;
                    }
                    setLoading(true);
                    setError("");
                    supabase
                      .from("cyclic_users")
                      .select("*")
                      .eq("username", username.trim().toLowerCase())
                      .eq("password", password)
                      .eq("is_active", true)
                      .maybeSingle()
                      .then(({ data, error: dbError }) => {
                        setLoading(false);
                        if (dbError || !data) {
                          setError("Usuario o clave incorrectos.");
                          return;
                        }
                        setPendingUser(data as CyclicUser);
                        setNewWspInput((data as CyclicUser).whatsapp || "");
                        setModalMode("changepass");
                      });
                  }}
                >
                  Cambiar clave
                </button>
              )}

              <button
                onClick={handleLogin}
                disabled={loading}
                className="w-full rounded-2xl bg-orange-600 px-4 py-3 text-sm font-black text-white disabled:opacity-50"
              >
                {loading ? "Ingresando..." : destination === "/inventarios" && inventoryMode === "register" ? "Registrarme e ingresar" : "Ingresar"}
              </button>
            </div>
          )}
        </section>
      </div>

      {modalMode === "whatsapp" && pendingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-xl">
            <h2 className="text-lg font-black">Registra tu WhatsApp</h2>
            <p className="mt-1 text-sm font-semibold text-slate-500">Hola {pendingUser.full_name}, necesitamos tu numero para continuar.</p>
            {modalError && <div className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm font-bold text-red-700">{modalError}</div>}
            <input className="mt-4 w-full rounded-2xl border px-4 py-3 text-sm font-semibold" placeholder="Ej: 51987654321" value={wspInput} onChange={event => setWspInput(event.target.value)} />
            <button className="mt-4 w-full rounded-2xl bg-orange-600 px-4 py-3 text-sm font-black text-white disabled:opacity-50" onClick={handleSaveWhatsapp} disabled={modalLoading}>
              {modalLoading ? "Guardando..." : "Guardar y entrar"}
            </button>
          </div>
        </div>
      )}

      {modalMode === "changepass" && pendingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-sm rounded-3xl bg-white p-5 shadow-xl">
            <h2 className="text-lg font-black">Cambiar clave</h2>
            <p className="mt-1 text-sm font-semibold text-slate-500">{pendingUser.full_name}</p>
            {modalError && <div className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm font-bold text-red-700">{modalError}</div>}
            <input className="mt-4 w-full rounded-2xl border px-4 py-3 text-sm font-semibold" placeholder="Nueva clave" type="password" value={newPass} onChange={event => setNewPass(event.target.value)} />
            <input className="mt-3 w-full rounded-2xl border px-4 py-3 text-sm font-semibold" placeholder="Confirmar clave" type="password" value={confirmPass} onChange={event => setConfirmPass(event.target.value)} />
            <input className="mt-3 w-full rounded-2xl border px-4 py-3 text-sm font-semibold" placeholder="WhatsApp" value={newWspInput} onChange={event => setNewWspInput(event.target.value)} />
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button className="rounded-2xl border px-4 py-3 text-sm font-black" onClick={() => setModalMode(null)}>Cancelar</button>
              <button className="rounded-2xl bg-slate-900 px-4 py-3 text-sm font-black text-white disabled:opacity-50" onClick={handleChangePassword} disabled={modalLoading}>
                {modalLoading ? "Guardando..." : "Guardar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
