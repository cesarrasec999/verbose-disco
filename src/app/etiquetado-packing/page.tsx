"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Download, LogOut, PackageCheck, RefreshCw, Save, Search, Tags } from "lucide-react";
import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase/client";

type Role = "Operario" | "Validador" | "Supervisor" | "Administrador";

type CyclicUser = {
  id: string;
  username: string;
  full_name: string;
  role: Role;
  store_id: string | null;
  can_access_all_stores: boolean;
  module_access?: string[] | null;
};

type Store = {
  id: string;
  name: string;
  code?: string | null;
  is_active: boolean;
};

type Product = {
  id: string;
  sku: string;
  description: string;
  unit: string;
};

type PackingTask = {
  id: string;
  store_id: string | null;
  product_id: string | null;
  product_code: string;
  description: string | null;
  unit: string | null;
  action_type: "etiquetar" | "armar";
  quantity: number;
  status: "pendiente" | "hecho" | "cancelado";
  note: string | null;
  created_by_name: string | null;
  created_at: string;
  finished_at?: string | null;
  updated_at: string;
  stores?: { name?: string | null } | null;
};

function fullProductCode(value: string | number | null | undefined): string {
  return String(value ?? "").trim().replace(/\.0+$/, "").toUpperCase();
}

function canExport(user: CyclicUser | null) {
  return user?.role === "Administrador" || user?.role === "Validador";
}

function canAccessPacking(user: CyclicUser) {
  if (Array.isArray(user.module_access) && user.module_access.length > 0) {
    return user.module_access.includes("packing");
  }
  return user.role === "Administrador" || user.role === "Supervisor" || user.role === "Validador" || user.role === "Operario";
}

export default function EtiquetadoPackingPage() {
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [stores, setStores] = useState<Store[]>([]);
  const [storeId, setStoreId] = useState("");
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [actionType, setActionType] = useState<"etiquetar" | "armar">("etiquetar");
  const [quantity, setQuantity] = useState("1");
  const [note, setNote] = useState("");
  const [tasks, setTasks] = useState<PackingTask[]>([]);
  const [statusFilter, setStatusFilter] = useState<"todos" | "pendiente" | "hecho" | "cancelado">("todos");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const selectedStoreName = useMemo(
    () => stores.find(store => store.id === storeId)?.name || "Sin tienda",
    [stores, storeId]
  );

  useEffect(() => {
    const raw = localStorage.getItem("cyclic_user");
    if (!raw) {
      window.location.replace("/");
      return;
    }
    const parsed = JSON.parse(raw) as CyclicUser;
    if (!canAccessPacking(parsed)) {
      window.location.replace("/");
      return;
    }
    setUser(parsed);
    void loadInitialData(parsed);
  }, []);

  async function loadInitialData(currentUser: CyclicUser) {
    const { data } = await supabase.from("stores").select("id,name,code,is_active").eq("is_active", true).order("name");
    const storeRows = (data || []) as Store[];
    const allowedStores = currentUser.can_access_all_stores
      ? storeRows
      : storeRows.filter(store => store.id === currentUser.store_id);
    setStores(allowedStores);
    const firstStore = currentUser.can_access_all_stores ? (currentUser.store_id || allowedStores[0]?.id || "") : (allowedStores[0]?.id || "");
    setStoreId(firstStore);
    await loadTasks(firstStore);
  }

  async function loadTasks(nextStoreId = storeId) {
    setLoading(true);
    setMessage("");
    try {
      let queryBuilder = supabase
        .from("packing_label_tasks")
        .select("*, stores(name)")
        .order("created_at", { ascending: false })
        .limit(500);
      if (nextStoreId) queryBuilder = queryBuilder.eq("store_id", nextStoreId);
      if (statusFilter !== "todos") queryBuilder = queryBuilder.eq("status", statusFilter);
      const { data, error } = await queryBuilder;
      if (error) throw error;
      setTasks((data || []) as PackingTask[]);
    } catch (error: unknown) {
      const text = error instanceof Error ? error.message : String(error);
      setMessage("No se pudo cargar Etiquetado/Packing. Ejecuta supabase_etiquetado_packing.sql: " + text);
    } finally {
      setLoading(false);
    }
  }

async function searchProducts() {
    const clean = fullProductCode(query);
    if (!clean) return;
    setLoading(true);
    setMessage("");
    try {
      const { data, error } = await supabase
        .from("cyclic_products")
        .select("id,sku,description,unit")
        .eq("is_active", true)
        .or(`sku.ilike.%${clean}%,barcode.ilike.%${clean}%,description.ilike.%${clean}%`)
        .order("sku", { ascending: true })
        .limit(30);
      if (error) throw error;

      const byId = new Map<string, Product>();
      for (const row of (data || []) as Product[]) byId.set(row.id, row);

      const { data: barcodeRows, error: barcodeError } = await supabase
        .from("codigos_barra")
        .select("codsap,upc,alu")
        .or(`upc.eq.${clean},alu.eq.${clean}`)
        .limit(50);

      if (!barcodeError) {
        const mappedCodes = [...new Set((barcodeRows || [])
          .map((row: any) => fullProductCode(row.codsap))
          .filter(Boolean))];

        if (mappedCodes.length > 0) {
          const { data: mappedProducts, error: mappedError } = await supabase
            .from("cyclic_products")
            .select("id,sku,description,unit")
            .eq("is_active", true)
            .in("sku", mappedCodes)
            .limit(50);
          if (mappedError) throw mappedError;
          for (const row of (mappedProducts || []) as Product[]) byId.set(row.id, row);
        }
      }

      const rows = [...byId.values()].sort((a, b) => a.sku.localeCompare(b.sku)).slice(0, 50);
      setProducts(rows);
      if (rows.length === 1) setSelectedProduct(rows[0]);
      if (rows.length === 0) setMessage("No se encontro el producto.");
    } catch (error: unknown) {
      setMessage("Error buscando producto: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setLoading(false);
    }
  }

  async function saveTask() {
    if (!user || !selectedProduct) {
      setMessage("Busca y selecciona un producto.");
      return;
    }
    const numericQty = Number(quantity || 1);
    if (!Number.isFinite(numericQty) || numericQty <= 0) {
      setMessage("Ingresa una cantidad valida.");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const now = new Date().toISOString();
      const { error } = await supabase.from("packing_label_tasks").insert({
        store_id: storeId || null,
        product_id: selectedProduct.id,
        product_code: selectedProduct.sku,
        description: selectedProduct.description,
        unit: selectedProduct.unit,
        action_type: actionType,
        quantity: numericQty,
        status: "pendiente",
        note: note.trim() || null,
        created_by: user.id,
        created_by_name: user.full_name,
        updated_at: now,
      });
      if (error) throw error;
      setMessage(`${selectedProduct.sku} marcado para ${actionType === "etiquetar" ? "etiquetar" : "armar"}.`);
      setQuery("");
      setProducts([]);
      setSelectedProduct(null);
      setQuantity("1");
      setNote("");
      await loadTasks(storeId);
    } catch (error: unknown) {
      setMessage("No se pudo guardar. Ejecuta supabase_etiquetado_packing.sql: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setLoading(false);
    }
  }

  async function updateStatus(row: PackingTask, status: PackingTask["status"]) {
    setLoading(true);
    try {
      if (status === "cancelado" && !window.confirm(`Cancelar el registro de ${row.product_code}?`)) {
        setLoading(false);
        return;
      }
      const now = new Date().toISOString();
      const { error } = await supabase
        .from("packing_label_tasks")
        .update({
          status,
          updated_at: now,
          finished_at: status === "hecho" ? now : null,
        })
        .eq("id", row.id);
      if (error) throw error;
      await loadTasks(storeId);
    } catch (error: unknown) {
      setMessage("No se pudo actualizar estado: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setLoading(false);
    }
  }

  function exportExcel() {
    if (!canExport(user)) return;
    const rows = tasks.map(row => ({
      Tienda: row.stores?.name || selectedStoreName,
      Codigo: row.product_code,
      Descripcion: row.description || "",
      UM: row.unit || "",
      Accion: row.action_type === "etiquetar" ? "Etiquetar" : "Armar",
      Cantidad: Number(row.quantity || 0),
      Estado: row.status,
      Nota: row.note || "",
      Usuario: row.created_by_name || "",
      "Hora inicio": row.created_at,
      "Hora fin": row.finished_at || "",
      Actualizado: row.updated_at,
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "EtiquetadoPacking");
    XLSX.writeFile(workbook, `etiquetado_packing_${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  if (!user) return <main className="min-h-screen bg-slate-100 p-6 text-slate-600">Validando acceso...</main>;

  return (
    <main className="min-h-screen bg-slate-100 text-slate-900">
      <header className="sticky top-0 z-20 border-b bg-white px-4 py-3">
        <div className="mx-auto flex max-w-6xl items-center gap-3">
          <button onClick={() => window.location.href = "/"} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50" title="Volver">
            <ArrowLeft size={18} />
          </button>
          <div className="grid h-11 w-11 place-items-center rounded-2xl bg-cyan-600 text-white">
            <Tags size={24} />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-black">Etiquetado/Packing</h1>
            <p className="truncate text-xs font-semibold text-slate-500">{user.full_name} - {selectedStoreName}</p>
          </div>
          <button onClick={() => loadTasks(storeId)} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50" title="Actualizar">
            <RefreshCw size={18} className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={() => { localStorage.removeItem("cyclic_user"); window.location.href = "/"; }} className="rounded-xl border p-2 text-slate-600 hover:bg-slate-50" title="Cerrar sesion">
            <LogOut size={18} />
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-4 p-4">
        {message && <div className="rounded-2xl border border-blue-200 bg-blue-50 p-3 text-sm font-bold text-blue-800">{message}</div>}

        <section className="grid gap-4 lg:grid-cols-[420px_1fr]">
          <div className="rounded-3xl border bg-white p-4 shadow-sm">
            <h2 className="text-lg font-black">Marcar producto</h2>
            <p className="mt-1 text-sm font-semibold text-slate-500">Selecciona si el producto requiere etiqueta o armado.</p>

            <div className="mt-4 space-y-3">
              <select
                className="w-full rounded-2xl border bg-white px-3 py-3 text-sm font-semibold"
                value={storeId}
                onChange={event => { setStoreId(event.target.value); void loadTasks(event.target.value); }}
                disabled={!user.can_access_all_stores && Boolean(user.store_id)}
              >
                <option value="">Sin tienda</option>
                {stores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}
              </select>

              <div className="flex gap-2">
                <input
                  className="min-w-0 flex-1 rounded-2xl border px-3 py-3 text-sm font-semibold"
                  placeholder="Codigo, barra o descripcion"
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  onKeyDown={event => { if (event.key === "Enter") void searchProducts(); }}
                />
                <button onClick={searchProducts} className="rounded-2xl bg-slate-900 px-4 text-white" title="Buscar">
                  <Search size={18} />
                </button>
              </div>

              {products.length > 0 && (
                <div className="max-h-56 overflow-auto rounded-2xl border">
                  {products.map(product => (
                    <button
                      key={product.id}
                      onClick={() => setSelectedProduct(product)}
                      className={`block w-full border-b px-3 py-2 text-left text-sm hover:bg-slate-50 ${selectedProduct?.id === product.id ? "bg-cyan-50" : ""}`}
                    >
                      <div className="font-black">{product.sku}</div>
                      <div className="text-xs text-slate-500">{product.description}</div>
                    </button>
                  ))}
                </div>
              )}

              {selectedProduct && (
                <div className="rounded-2xl border bg-slate-50 p-3 text-sm">
                  <div className="font-black">{selectedProduct.sku}</div>
                  <div className="text-slate-600">{selectedProduct.description}</div>
                  <div className="text-xs font-bold text-slate-400">UM: {selectedProduct.unit}</div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2 rounded-2xl border p-1">
                <button onClick={() => setActionType("etiquetar")} className={`rounded-xl px-3 py-3 text-sm font-black ${actionType === "etiquetar" ? "bg-cyan-600 text-white" : "text-slate-600"}`}>Etiquetar</button>
                <button onClick={() => setActionType("armar")} className={`rounded-xl px-3 py-3 text-sm font-black ${actionType === "armar" ? "bg-slate-900 text-white" : "text-slate-600"}`}>Armar</button>
              </div>

              <input className="w-full rounded-2xl border px-3 py-3 text-sm font-semibold" type="number" min="1" value={quantity} onChange={event => setQuantity(event.target.value)} placeholder="Cantidad" />
              <textarea className="min-h-24 w-full rounded-2xl border px-3 py-3 text-sm font-semibold" value={note} onChange={event => setNote(event.target.value)} placeholder="Observacion opcional" />

              <button onClick={saveTask} disabled={loading || !selectedProduct} className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-cyan-700 px-4 py-3 text-sm font-black text-white disabled:opacity-40">
                <Save size={18} /> Guardar marca
              </button>
            </div>
          </div>

          <div className="rounded-3xl border bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
              <div>
                <h2 className="text-lg font-black">Registros guardados</h2>
                <p className="text-xs font-semibold text-slate-500">{tasks.length} registros visibles</p>
              </div>
              <div className="flex gap-2">
                <select className="rounded-xl border px-3 py-2 text-sm font-bold" value={statusFilter} onChange={event => setStatusFilter(event.target.value as typeof statusFilter)}>
                  <option value="todos">Todos</option>
                  <option value="pendiente">Pendiente</option>
                  <option value="hecho">Hecho</option>
                  <option value="cancelado">Cancelado</option>
                </select>
                <button onClick={() => loadTasks(storeId)} className="rounded-xl border px-3 py-2 text-sm font-black">Filtrar</button>
                {canExport(user) && (
                  <button onClick={exportExcel} disabled={tasks.length === 0} className="inline-flex items-center gap-2 rounded-xl bg-green-700 px-3 py-2 text-sm font-black text-white disabled:opacity-40">
                    <Download size={16} /> Excel
                  </button>
                )}
              </div>
            </div>

            <div className="max-h-[68vh] overflow-auto">
              <table className="w-full min-w-[840px] text-sm">
                <thead className="sticky top-0 bg-slate-100 text-xs text-slate-600">
                  <tr>
                    <th className="p-2 text-left">Codigo</th>
                    <th className="p-2 text-left">Descripcion</th>
                    <th className="p-2">Accion</th>
                    <th className="p-2">Cant.</th>
                    <th className="p-2">Estado</th>
                    <th className="p-2 text-left">Usuario</th>
                    <th className="p-2">Inicio</th>
                    <th className="p-2">Fin</th>
                    <th className="p-2">Cambiar</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map(row => (
                    <tr key={row.id} className="border-b hover:bg-slate-50">
                      <td className="p-2 font-black">{row.product_code}</td>
                      <td className="p-2 text-slate-600">{row.description || ""}</td>
                      <td className="p-2 text-center font-black">{row.action_type === "etiquetar" ? "Etiquetar" : "Armar"}</td>
                      <td className="p-2 text-center font-black">{Number(row.quantity || 0).toLocaleString("es-PE")}</td>
                      <td className="p-2 text-center">
                        <span className={`rounded-full px-2 py-1 text-xs font-black ${row.status === "hecho" ? "bg-green-100 text-green-700" : row.status === "cancelado" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>{row.status}</span>
                      </td>
                      <td className="p-2 text-xs font-semibold text-slate-500">{row.created_by_name || ""}</td>
                      <td className="p-2 text-center text-xs">{new Date(row.created_at).toLocaleString("es-PE")}</td>
                      <td className="p-2 text-center text-xs">{row.finished_at ? new Date(row.finished_at).toLocaleString("es-PE") : "-"}</td>
                      <td className="p-2 text-center">
                        <div className="flex justify-center gap-1">
                          <button onClick={() => updateStatus(row, "hecho")} disabled={row.status === "cancelado"} className="rounded-lg border px-2 py-1 text-xs font-bold text-green-700 disabled:opacity-40">Hecho</button>
                          <button onClick={() => updateStatus(row, "cancelado")} disabled={row.status === "cancelado"} className="rounded-lg border px-2 py-1 text-xs font-bold text-red-600 disabled:opacity-40">
                            {row.status === "cancelado" ? "Cancelado" : "Cancelar registro"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {tasks.length === 0 && (
                    <tr><td colSpan={9} className="p-8 text-center text-sm font-semibold text-slate-400">Sin registros guardados.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
