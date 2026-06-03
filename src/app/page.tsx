"use client";

import { useEffect, useMemo, useState } from "react";
import { Boxes, Camera, ClipboardCheck, FileText, LogOut, MapPin, PackageCheck, PackageX, ScanLine, Search, ShieldCheck, Tags, UserCog, Warehouse } from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import {
  hasExplicitModuleAccess,
  normalizedModuleAccess,
  type ModuleAccessKey,
} from "@/features/access/moduleAccess";
import {
  endSingleDeviceSession,
  onStoredSessionExpired,
  readStoredUser,
  startSingleDeviceSession,
  writeStoredUser,
} from "@/lib/singleDeviceSession";

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
  cyclic_session_token?: string;
  cyclic_device_id?: string;
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

type LoginDestination = "/dashboard" | "/ubicaciones" | "/auditoria" | "/inventarios" | "/picking" | "/etiquetado-packing" | "/consulta-stock" | "/reportes" | "/no-inventariables" | "/usuarios" | "/recepcion" | "/confirmaciones";
type InventoryAuthMode = "login" | "register";

const GENERAL_INVENTORY_SESSION_KEY = "general_inventory_session_id";

const MODULES: Array<{
  label: string;
  description: string;
  destination: LoginDestination;
  icon: typeof ClipboardCheck;
  accent: string;
}> = [
  { label: "Conteo Ciclico", description: "Conteos por tienda y validacion diaria", destination: "/dashboard", icon: ClipboardCheck, accent: "bg-blue-600" },
  { label: "Ubicaciones", description: "Consulta y mantenimiento de ubicaciones", destination: "/ubicaciones", icon: MapPin, accent: "bg-emerald-600" },
  { label: "Auditorias", description: "Revision y control de auditorias", destination: "/auditoria", icon: ShieldCheck, accent: "bg-amber-500" },
  { label: "Inventarios", description: "Conteo por ubicaciones y reconteos", destination: "/inventarios", icon: Warehouse, accent: "bg-emerald-600" },
  { label: "Consulta", description: "Consulta de stock y codigos", destination: "/consulta-stock", icon: Search, accent: "bg-sky-600" },
  { label: "Picking", description: "Modulo en preparacion", destination: "/picking", icon: ScanLine, accent: "bg-violet-600" },
  { label: "Etiquetado/Packing", description: "Marcar productos para etiquetar o armar", destination: "/etiquetado-packing", icon: Tags, accent: "bg-cyan-600" },
  { label: "Reportes", description: "Stock, rotaciones, ventas y presupuesto", destination: "/reportes", icon: FileText, accent: "bg-slate-900" },
  { label: "No Inventariables", description: "Códigos excluidos de conteos cíclicos e inventarios", destination: "/no-inventariables", icon: PackageX, accent: "bg-orange-600" },
  { label: "Usuarios", description: "Gestión de usuarios y permisos del sistema", destination: "/usuarios", icon: UserCog, accent: "bg-purple-600" },
  { label: "Recepción", description: "Recepcionar requerimientos aprobados de abastecimiento", destination: "/recepcion", icon: PackageCheck, accent: "bg-teal-600" },
  { label: "Confirmaciones", description: "Fotos y validacion de pagos", destination: "/confirmaciones", icon: Camera, accent: "bg-rose-600" },
];

const DESTINATION_MODULE: Record<LoginDestination, ModuleAccessKey> = {
  "/dashboard": "cyclic_count_take",
  "/ubicaciones": "locations",
  "/auditoria": "audit",
  "/inventarios": "general_inventory",
  "/picking": "picking",
  "/etiquetado-packing": "packing",
  "/consulta-stock": "consulta",
  "/reportes": "reports",
  "/no-inventariables": "reports_non_inventory",
  "/usuarios": "users",
  "/recepcion": "reception",
  "/confirmaciones": "confirmations",
};

function userModuleAccess(user: CyclicUser): ModuleAccessKey[] {
  return normalizedModuleAccess(user);
}

function normalizePhone(value: string) {
  return value.replace(/\D/g, "");
}

export default function LoginPage() {
  const [selectedModule, setSelectedModule] = useState<(typeof MODULES)[number] | null>(null);
  const [authenticatedUser, setAuthenticatedUser] = useState<CyclicUser | null>(() => {
    if (typeof window === "undefined") return null;
    return readStoredUser<CyclicUser>();
  });
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

  const allowedModules = useMemo(() => {
    if (!authenticatedUser) return [];
    return MODULES.filter(module => canEnterDestination(authenticatedUser, module.destination));
  }, [authenticatedUser]);
  const SelectedIcon = selectedModule?.icon || Boxes;
  const loginPlaceholder = selectedModule?.destination === "/inventarios" || inventoryMode === "register" ? "Celular" : "ID / usuario";

  function canEnterDestination(user: CyclicUser, targetDestination: LoginDestination) {
    const moduleKey = DESTINATION_MODULE[targetDestination];
    // Módulos con acceso directo por clave — sin lógica de roles adicional
    if (targetDestination === "/no-inventariables" || targetDestination === "/usuarios" || targetDestination === "/recepcion" || targetDestination === "/confirmaciones") {
      return userModuleAccess(user).includes(moduleKey);
    }
    if (targetDestination === "/dashboard") {
      const access = userModuleAccess(user);
      const cyclicModules = [
        "cyclic_count_take",
        "cyclic_assign_products",
        "cyclic_count_records",
        "cyclic_summary_by_code",
        "cyclic_store_progress",
        "cyclic_dashboard",
      ] satisfies ModuleAccessKey[];
      if (!cyclicModules.some(key => access.includes(key))) return false;
      return true;
    }
    if (targetDestination === "/reportes") {
      const access = userModuleAccess(user);
      return access.includes("reports") || access.includes("reports_non_inventory") || access.includes("reports_results");
    }
    if (moduleKey && !userModuleAccess(user).includes(moduleKey)) return false;
    if (hasExplicitModuleAccess(user)) return true;
    if (targetDestination === "/auditoria") return user.role === "Administrador" || user.role === "Supervisor" || user.role === "Validador" || user.can_access_audit;
    if (targetDestination === "/inventarios") return user.role === "Administrador" || user.role === "Validador" || user.role === "Supervisor";
    if (targetDestination === "/picking") return user.role === "Administrador" || user.role === "Validador" || user.role === "Supervisor";
    return true;
  }

  function enterSelectedDestination(user: CyclicUser, module: (typeof MODULES)[number]) {
    if (!canEnterDestination(user, module.destination)) {
      setError("Tu usuario no tiene acceso a este modulo.");
      return false;
    }
    writeStoredUser(user);
    window.location.assign(module.destination);
    return true;
  }

  function enterInventory(operator: InventoryOperator, sessionId: string) {
    localStorage.removeItem("cyclic_user");
    localStorage.setItem("general_inventory_operator", JSON.stringify(operator));
    localStorage.setItem(GENERAL_INVENTORY_SESSION_KEY, sessionId);
    window.location.assign("/inventarios");
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
    if (inventoryMode !== "register") return;
    const timer = window.setTimeout(() => void loadInventorySessions(), 0);
    return () => window.clearTimeout(timer);
  }, [inventoryMode]);

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

  async function tryEnterInventoryOperator(phone: string, pass: string) {
    const { data, error: dbError } = await supabase
      .from("general_inventory_operators")
      .select("id,full_name,phone")
      .eq("phone", phone)
      .eq("password", pass)
      .maybeSingle();

    if (dbError || !data) return false;

    const sessionId = await findOperatorInventorySession((data as InventoryOperator).id);
    if (!sessionId) {
      setError("No tienes un inventario activo asociado. Pide al validador que te registre.");
      return true;
    }
    enterInventory(data as InventoryOperator, sessionId);
    return true;
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
    setLoading(true);
    setError("");
    const phone = normalizePhone(username);
    const { data, error: dbError } = await supabase
      .rpc("verify_cyclic_user", {
        p_username: username.trim().toLowerCase(),
        p_password: password
      })
      .maybeSingle();

    if (dbError || !data) {
      if (phone.length >= 8 && await tryEnterInventoryOperator(phone, password.trim())) {
        setLoading(false);
        return;
      }
      setError("Usuario/celular o clave incorrectos.");
      setLoading(false);
      return;
    }

    const user = data as CyclicUser;
    if (MODULES.filter(module => canEnterDestination(user, module.destination)).length === 0) {
      setError("Tu usuario no tiene modulos permitidos.");
      setLoading(false);
      return;
    }

    if (!user.whatsapp) {
      setPendingUser(user);
      setModalMode("whatsapp");
      setLoading(false);
      return;
    }

    try {
      const sessionUser = await startSingleDeviceSession(user);
      setAuthenticatedUser(sessionUser);
    } catch (sessionError) {
      setError("No se pudo iniciar la sesion unica. Ejecuta la migracion de sesiones y vuelve a intentar. Detalle: " + (sessionError instanceof Error ? sessionError.message : String(sessionError)));
      setLoading(false);
      return;
    }
    setSelectedModule(null);
    setUsername("");
    setPassword("");
    setLoading(false);
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
    const updatedUser = { ...pendingUser, whatsapp: wsp };
    try {
      const sessionUser = await startSingleDeviceSession(updatedUser);
      setAuthenticatedUser(sessionUser);
    } catch (sessionError) {
      setModalError("Numero guardado, pero no se pudo iniciar la sesion unica. Ejecuta la migracion de sesiones. Detalle: " + (sessionError instanceof Error ? sessionError.message : String(sessionError)));
      return;
    }
    setSelectedModule(null);
    setModalMode(null);
    setPendingUser(null);
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
    setModalLoading(true);
    const { data: changed, error: pwErr } = await supabase
      .rpc("change_cyclic_user_password", {
        p_username: pendingUser.username,
        p_old_password: password,
        p_new_password: newPass
      });
    if (pwErr || !changed) {
      setModalLoading(false);
      setModalError("Error al cambiar la clave. Intenta de nuevo.");
      return;
    }
    if (wsp) {
      await supabase.from("cyclic_users").update({ whatsapp: wsp }).eq("id", pendingUser.id);
    }
    setModalLoading(false);
    const updatedUser = { ...pendingUser, whatsapp: wsp || pendingUser.whatsapp };
    try {
      const sessionUser = await startSingleDeviceSession(updatedUser);
      setAuthenticatedUser(sessionUser);
    } catch (sessionError) {
      setModalError("Datos actualizados, pero no se pudo iniciar la sesion unica. Ejecuta la migracion de sesiones. Detalle: " + (sessionError instanceof Error ? sessionError.message : String(sessionError)));
      return;
    }
    setSelectedModule(null);
    setModalMode(null);
    setPendingUser(null);
    setNewPass("");
    setConfirmPass("");
  }

  useEffect(() => onStoredSessionExpired(() => {
    setAuthenticatedUser(null);
    setSelectedModule(null);
    setUsername("");
    setPassword("");
    setError("Tu sesion fue cerrada porque se inicio en otro dispositivo.");
  }), []);

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

      <div className="relative z-10 mx-auto grid min-h-[calc(100vh-48px)] max-w-7xl items-center gap-5 lg:grid-cols-[1fr_280px]">
        <section className="space-y-5">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-600 text-xl font-black text-white shadow-lg shadow-orange-950/40">R</div>
            <div>
              <h1 className="text-2xl font-black text-white">RASECORP</h1>
              <p className="text-sm font-semibold text-slate-300">{authenticatedUser ? "Selecciona un modulo permitido" : "Ingresa para ver tus modulos"}</p>
            </div>
          </div>

          {authenticatedUser ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {allowedModules.map(module => {
              const Icon = module.icon;
              const isActive = selectedModule?.destination === module.destination;
              return (
                <button
                  key={module.destination}
                  onClick={() => {
                    setSelectedModule(module);
                    setError("");
                    enterSelectedDestination(authenticatedUser, module);
                  }}
                  className={`group flex min-h-[104px] items-center gap-3 rounded-2xl border p-3 text-left shadow-xl shadow-slate-950/20 backdrop-blur-md transition ${
                    isActive
                      ? "border-orange-400 bg-white ring-2 ring-orange-400"
                      : "border-white/25 bg-white/92 hover:border-orange-300 hover:bg-white"
                  }`}
                >
                  <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-white ${module.accent}`}>
                    <Icon size={22} />
                  </span>
                  <span>
                    <span className="block text-base font-black text-slate-950">{module.label}</span>
                    <span className="mt-1 block text-xs font-semibold leading-5 text-slate-500">{module.description}</span>
                  </span>
                </button>
              );
            })}
            {allowedModules.length === 0 && (
              <div className="rounded-2xl border border-white/20 bg-white/90 p-5 text-sm font-bold text-slate-600">
                No tienes modulos activos. Pide al administrador que revise tus permisos.
              </div>
            )}
          </div>
          ) : (
            <div className="rounded-3xl border border-white/20 bg-white/10 p-5 text-sm font-semibold text-slate-200 backdrop-blur-md">
              Primero inicia sesion. Luego veras solamente los modulos que tienes permitido usar.
            </div>
          )}
        </section>

        <section className="rounded-3xl border border-white/25 bg-white/95 p-4 shadow-2xl shadow-slate-950/40 backdrop-blur-md">
          {authenticatedUser ? (
            <div className="flex min-h-[180px] flex-col items-center justify-center text-center">
              <Boxes size={34} className="text-slate-300" />
              <p className="mt-3 text-sm font-black leading-5">Hola, {authenticatedUser.full_name}</p>
              <p className="mt-1 text-xs font-semibold text-slate-500">Elige un modulo permitido.</p>
              <button
                type="button"
                className="mt-4 rounded-xl border px-3 py-1.5 text-xs font-black text-slate-600 hover:bg-slate-50"
                onClick={() => {
                  void endSingleDeviceSession();
                  sessionStorage.clear();
                  setAuthenticatedUser(null);
                  setSelectedModule(null);
                  setUsername("");
                  setPassword("");
                  setError("");
                }}
              >
                <LogOut className="mr-1.5 inline" size={14} /> Cerrar sesion
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-600 text-white">
                  <SelectedIcon size={24} />
                </div>
                <div>
                  <h2 className="text-xl font-black">{inventoryMode === "register" ? "Auto registro inventario" : "Iniciar sesion"}</h2>
                  <p className="text-xs font-semibold text-slate-500">
                    {selectedModule?.destination === "/inventarios"
                      ? inventoryMode === "register" ? "Entraras solo a la sesion de Inventarios Generales" : "Ingresa tu celular y clave para volver a tu inventario"
                      : "Ingresa tu ID y clave para ver tus modulos"}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 rounded-2xl border p-1">
                <button onClick={() => { setInventoryMode("login"); setError(""); }} className={`rounded-xl px-3 py-2 text-sm font-black ${inventoryMode === "login" ? "bg-slate-900 text-white" : "text-slate-600"}`}>Iniciar sesion</button>
                <button onClick={() => { setInventoryMode("register"); setError(""); }} className={`rounded-xl px-3 py-2 text-sm font-black ${inventoryMode === "register" ? "bg-slate-900 text-white" : "text-slate-600"}`}>Auto registro</button>
              </div>

              {error && <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</div>}

              {inventoryMode === "register" && (
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
                  onKeyDown={event => {
                    if (event.key !== "Enter") return;
                    void (inventoryMode === "register" ? handleInventoryAuth() : handleLogin());
                  }}
                />
                <button type="button" onClick={() => setShowPassword(prev => !prev)} className="absolute right-4 top-1/2 -translate-y-1/2 text-xs font-black text-slate-500">
                  {showPassword ? "Ocultar" : "Ver"}
                </button>
              </div>

              {inventoryMode === "register" && (
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

              {inventoryMode === "login" && selectedModule?.destination !== "/inventarios" && <button
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
                    .rpc("verify_cyclic_user", {
                      p_username: username.trim().toLowerCase(),
                      p_password: password
                    })
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
              </button>}

              <button
                onClick={inventoryMode === "register" ? handleInventoryAuth : handleLogin}
                disabled={loading}
                className="w-full rounded-2xl bg-orange-600 px-4 py-3 text-sm font-black text-white disabled:opacity-50"
              >
                {loading ? "Ingresando..." : inventoryMode === "register" ? "Registrarme e ingresar" : "Ingresar"}
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
