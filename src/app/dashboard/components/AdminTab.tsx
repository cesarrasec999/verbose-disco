"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { readSafeSheetMatrix, readSafeSheetObjects } from "@/lib/safeExcel";
import { UsersModule } from "@/features/usuarios/UsersModule";
import type { CyclicUser, Product, Store } from "@/features/ciclicos/types";
import { formatMoney, fullProductCode, normalizeText, parseCost } from "@/features/ciclicos/utils";

type AdminTabProps = {
  adminTab: "productos" | "tiendas" | "usuarios";
  user: CyclicUser | null;
  allStores: Store[];
  products: Product[];
  showMessage: (msg: string, type?: "info" | "success" | "error") => void;
  loadProducts: () => Promise<void>;
  loadStores: () => Promise<void>;
  canManageLocations: boolean;
};

export function AdminTab({
  adminTab,
  user,
  allStores,
  products,
  showMessage,
  loadProducts,
  loadStores,
  canManageLocations,
}: AdminTabProps) {
  // ─── Productos ────────────────────────────────────────────
  const [prodSearch, setProdSearch] = useState("");
  const [masterFile, setMasterFile] = useState<File | null>(null);
  const [masterFileName, setMasterFileName] = useState("");
  const [uploadProgress, setUploadProgress] = useState<{ step: string; pct: number } | null>(null);
  const masterInputRef = useRef<HTMLInputElement | null>(null);

  // ─── Códigos de barra ─────────────────────────────────────
  const [barcodesFile, setBarcodesFile] = useState<File | null>(null);
  const [barcodesFileName, setBarcodesFileName] = useState("");
  const [barcodesProgress, setBarcodesProgress] = useState<{ step: string; pct: number } | null>(null);
  const barcodesInputRef = useRef<HTMLInputElement | null>(null);

  // ─── Editar producto ──────────────────────────────────────
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [editProdSku, setEditProdSku] = useState("");
  const [editProdBarcode, setEditProdBarcode] = useState("");
  const [editProdDesc, setEditProdDesc] = useState("");
  const [editProdUnit, setEditProdUnit] = useState("");
  const [editProdCost, setEditProdCost] = useState("");

  // ─── Tiendas ──────────────────────────────────────────────
  const [newStoreName, setNewStoreName] = useState("");
  const [newStoreCode, setNewStoreCode] = useState("");

  // ─── Filtrado de productos ────────────────────────────────
  const filteredProducts = useMemo(() => {
    const text = prodSearch.trim().toLowerCase();
    if (!text) return products.slice(0, 100);
    return products.filter(p => [p.sku, p.description, p.barcode].join(" ").toLowerCase().includes(text)).slice(0, 100);
  }, [products, prodSearch]);

  // ─── Funciones ────────────────────────────────────────────

  async function uploadMaster() {
    if (!masterFile) { showMessage("Selecciona un archivo.", "error"); return; }
    if (!confirm("¿Seguro? Esto actualizará o insertará productos en el maestro global.")) return;
    try {
      const allRows = await readSafeSheetMatrix(masterFile, { maxBytes: 25 * 1024 * 1024, maxRows: 100000, maxCols: 25, raw: false });
      const dataRows = allRows.slice(1);
      const inputCodes = [...new Set(dataRows.map(row => fullProductCode(String(row[0] || ""))).filter(Boolean))];
      const codSapByInputCode = new Map<string, string>();
      const CHUNK = 500;
      for (let i = 0; i < inputCodes.length; i += CHUNK) {
        const chunk = inputCodes.slice(i, i + CHUNK);
        const { data: byUpc } = await supabase.from("codigos_barra").select("codsap, upc, alu").in("upc", chunk);
        const { data: byAlu } = await supabase.from("codigos_barra").select("codsap, upc, alu").in("alu", chunk);
        for (const row of [...(byUpc || []), ...(byAlu || [])]) {
          const codsap = fullProductCode(row.codsap);
          if (!codsap) continue;
          if (row.upc) codSapByInputCode.set(fullProductCode(String(row.upc)), codsap);
          if (row.alu) codSapByInputCode.set(fullProductCode(String(row.alu)), codsap);
        }
      }
      const map = new Map<string, any>();
      for (const row of dataRows) {
        const inputSku = fullProductCode(String(row[0] || ""));
        const rawSku = codSapByInputCode.get(inputSku) || inputSku;
        if (!rawSku) continue;
        const desc = String(row[1] || "").trim();
        if (!desc) continue;
        const unit = String(row[2] || "NIU").trim() || "NIU";
        const cost = parseCost(row[3]);
        map.set(normalizeText(rawSku), {
          sku: rawSku, barcode: null, description: desc, unit, cost, is_active: true,
          updated_at: new Date().toISOString(),
        });
      }
      if (map.size === 0) { showMessage("Archivo sin filas válidas. Verifica que tenga datos desde la fila 2.", "error"); return; }
      const items = Array.from(map.values());
      let ok = 0;
      const BATCH = 500;
      for (let i = 0; i < items.length; i += BATCH) {
        const batch = items.slice(i, i + BATCH);
        setUploadProgress({ step: `Procesando ${Math.min(i + BATCH, items.length)} / ${items.length}...`, pct: Math.round((Math.min(i + BATCH, items.length) / items.length) * 100) });
        const { error } = await supabase.from("cyclic_products").upsert(batch, { onConflict: "sku" });
        if (!error) ok += batch.length;
      }
      setUploadProgress(null);
      showMessage(`✅ ${ok} productos procesados en el maestro global.`, "success");
      setMasterFile(null); setMasterFileName("");
      await loadProducts();
    } catch (e: any) {
      setUploadProgress(null);
      showMessage("Error: " + e.message, "error");
    }
  }

  async function uploadBarcodes() {
    if (!barcodesFile) { showMessage("Selecciona un archivo de códigos de barra.", "error"); return; }
    if (!confirm("¿Seguro? Esto actualizará los códigos de barra del maestro global.")) return;
    try {
      const rows = await readSafeSheetObjects<Record<string, unknown>>(barcodesFile, { maxBytes: 25 * 1024 * 1024, maxRows: 100000, maxCols: 25, raw: false });
      let ok = 0, notFound = 0;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        setBarcodesProgress({ step: `Procesando ${i + 1} / ${rows.length}...`, pct: Math.round(((i + 1) / rows.length) * 100) });
        const rawSku = fullProductCode(String(row["CODIGO"] || ""));
        if (!rawSku) continue;
        const b1 = fullProductCode(String(row["CODIGO DE BARRA 1"] || ""));
        const b2 = fullProductCode(String(row["CODIGO DE BARRA 2"] || ""));
        const barcode = b1 || b2 || null;
        if (!barcode) continue;
        const { data: prod } = await supabase.from("cyclic_products").select("id").eq("sku", rawSku).maybeSingle();
        if (!prod) { notFound++; continue; }
        const { error } = await supabase.from("cyclic_products")
          .update({ barcode, updated_at: new Date().toISOString() })
          .eq("id", prod.id);
        if (!error) ok++;
        else notFound++;
      }
      setBarcodesProgress(null);
      showMessage(`✅ ${ok} códigos de barra actualizados. ${notFound} SKUs no encontrados.`, ok > 0 ? "success" : "error");
      setBarcodesFile(null); setBarcodesFileName("");
      await loadProducts();
    } catch (e: any) {
      setBarcodesProgress(null);
      showMessage("Error: " + e.message, "error");
    }
  }

  async function saveEditProduct() {
    if (!editingProduct || !user) return;
    const sku = editProdSku.trim();
    const desc = editProdDesc.trim();
    if (!sku || !desc) { showMessage("SKU y descripción son obligatorios.", "error"); return; }
    const cost = Number(editProdCost);
    if (isNaN(cost) || cost < 0) { showMessage("Costo inválido.", "error"); return; }
    const { error } = await supabase.from("cyclic_products").update({
      sku, barcode: editProdBarcode.trim() || null, description: desc,
      unit: editProdUnit.trim() || "NIU", cost,
      updated_at: new Date().toISOString(),
    }).eq("id", editingProduct.id);
    if (error) { showMessage("Error: " + error.message, "error"); return; }
    showMessage("✅ Producto actualizado.", "success");
    setEditingProduct(null);
    await loadProducts();
  }

  async function createStore() {
    if (!newStoreName.trim()) { showMessage("Nombre de tienda requerido.", "error"); return; }
    const { error } = await supabase.from("stores").insert({
      name: newStoreName.trim(), code: newStoreCode.trim() || newStoreName.trim().toUpperCase().slice(0, 8),
      is_active: true,
    });
    if (error) { showMessage("Error: " + error.message, "error"); return; }
    showMessage("✅ Tienda creada.", "success");
    setNewStoreName(""); setNewStoreCode("");
    await loadStores();
  }

  async function toggleStoreActive(store: Store) {
    const { error } = await supabase.from("stores").update({ is_active: !store.is_active }).eq("id", store.id);
    if (error) { showMessage("Error: " + error.message, "error"); return; }
    await loadStores();
  }

  return (
    <>
      {/* ── ADMIN: MAESTRO PRODUCTOS ──────────────────────── */}
      {adminTab === "productos" && (
        <>
          <section className="bg-white rounded-3xl p-5 shadow space-y-4">
            <div>
              <h2 className="text-xl font-bold text-slate-900">Maestro global de productos</h2>
              <p className="text-slate-500 text-sm mt-1">Sube 2 archivos: el <b>Maestro de productos</b> y los <b>Códigos de barra</b>.</p>
            </div>

            <div className="rounded-2xl bg-slate-50 border p-4 space-y-2">
              <p className="text-sm font-semibold text-slate-700">📋 Archivo 1 — Maestro de productos</p>
              <p className="text-xs text-slate-400">Columnas por posición (la fila 1 se ignora): <b>A: Código</b> · <b>B: Descripción</b> · <b>C: Unidad de medida</b> · <b>D: Costo</b> · <b>E: Stock</b>. El encabezado no importa, solo el orden de columnas.</p>
              {uploadProgress && (
                <div className="rounded-xl bg-blue-50 border border-blue-200 p-3 space-y-1">
                  <p className="text-xs font-semibold text-blue-800">{uploadProgress.step}</p>
                  <div className="h-2 bg-blue-200 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-600 rounded-full transition-all" style={{ width: `${uploadProgress.pct}%` }} />
                  </div>
                </div>
              )}
              <div className="flex gap-3 flex-wrap items-center">
                <button className="px-4 py-2.5 rounded-2xl border font-semibold text-sm bg-white text-slate-700" onClick={() => masterInputRef.current?.click()}>
                  {masterFileName || "Seleccionar Excel"}
                </button>
                <input ref={masterInputRef} type="file" accept=".xlsx,.xls" className="hidden"
                  onChange={e => { const f = e.target.files?.[0] || null; setMasterFile(f); setMasterFileName(f?.name || ""); e.target.value = ""; }} />
                {masterFile && (
                  <button className="px-4 py-2.5 rounded-2xl bg-slate-900 text-white font-semibold text-sm" onClick={uploadMaster}>Subir maestro</button>
                )}
                <span className="text-xs text-slate-400">{products.length.toLocaleString()} productos activos</span>
              </div>
            </div>

            <div className="rounded-2xl bg-slate-50 border p-4 space-y-2">
              <p className="text-sm font-semibold text-slate-700">🔖 Archivo 2 — Códigos de barra</p>
              <p className="text-xs text-slate-400">Columnas: <b>CODIGO</b>, <b>CODIGO DE BARRA 1</b>, <b>CODIGO DE BARRA 2</b>. Se sube 1 sola vez.</p>
              {barcodesProgress && (
                <div className="rounded-xl bg-blue-50 border border-blue-200 p-3 space-y-1">
                  <p className="text-xs font-semibold text-blue-800">{barcodesProgress.step}</p>
                  <div className="h-2 bg-blue-200 rounded-full overflow-hidden">
                    <div className="h-full bg-blue-600 rounded-full transition-all" style={{ width: `${barcodesProgress.pct}%` }} />
                  </div>
                </div>
              )}
              <div className="flex gap-3 flex-wrap items-center">
                <button className="px-4 py-2.5 rounded-2xl border font-semibold text-sm bg-white text-slate-700" onClick={() => barcodesInputRef.current?.click()}>
                  {barcodesFileName || "Seleccionar Excel"}
                </button>
                <input ref={barcodesInputRef} type="file" accept=".xlsx,.xls" className="hidden"
                  onChange={e => { const f = e.target.files?.[0] || null; setBarcodesFile(f); setBarcodesFileName(f?.name || ""); e.target.value = ""; }} />
                {barcodesFile && (
                  <button className="px-4 py-2.5 rounded-2xl bg-slate-900 text-white font-semibold text-sm" onClick={uploadBarcodes}>Actualizar códigos</button>
                )}
              </div>
            </div>
          </section>

          <section className="bg-white rounded-3xl p-5 shadow space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h3 className="font-bold text-slate-900">Productos del maestro</h3>
              <input className="border rounded-2xl px-3 py-2 text-sm w-64 text-slate-900 bg-white" placeholder="Buscar SKU o descripción..." value={prodSearch} onChange={e => setProdSearch(e.target.value)} />
            </div>
            <div className="border rounded-2xl overflow-hidden">
              <div className="max-h-[450px] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-100 sticky top-0">
                    <tr>
                      <th className="p-2 border text-left">SKU</th>
                      <th className="p-2 border text-left">Descripción</th>
                      <th className="p-2 border">UM</th>
                      <th className="p-2 border">Costo</th>
                      <th className="p-2 border">Código barra</th>
                      <th className="p-2 border">Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredProducts.map(p => (
                      <tr key={p.id} className="hover:bg-slate-50">
                        <td className="p-2 border font-medium">{p.sku}</td>
                        <td className="p-2 border text-slate-600 max-w-[200px] whitespace-normal break-words">{p.description}</td>
                        <td className="p-2 border text-center">{p.unit}</td>
                        <td className="p-2 border text-center">{formatMoney(p.cost)}</td>
                        <td className="p-2 border text-center font-mono text-xs">{p.barcode || "—"}</td>
                        <td className="p-2 border text-center">
                          <button className="px-3 py-1.5 rounded-lg border text-xs font-semibold" onClick={() => { setEditingProduct(p); setEditProdSku(p.sku); setEditProdBarcode(p.barcode || ""); setEditProdDesc(p.description); setEditProdUnit(p.unit); setEditProdCost(String(p.cost)); }}>Editar</button>
                        </td>
                      </tr>
                    ))}
                    {filteredProducts.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-slate-400">No hay productos.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
            {!prodSearch && products.length > 100 && (
              <p className="text-xs text-slate-400 text-center">Mostrando primeros 100 de {products.length.toLocaleString()}. Usa el buscador para filtrar.</p>
            )}
          </section>
        </>
      )}

      {/* ── ADMIN: TIENDAS ────────────────────────────────── */}
      {adminTab === "tiendas" && (
        <section className="bg-white rounded-3xl p-5 shadow space-y-4">
          <h2 className="text-xl font-bold text-slate-900">Tiendas</h2>
          {canManageLocations && (
            <div className="rounded-2xl bg-slate-50 border p-4 space-y-3">
              <p className="text-sm font-semibold text-slate-700">Nueva tienda</p>
              <div className="flex gap-3 flex-wrap">
                <input className="flex-1 border rounded-2xl p-3 text-sm bg-white text-slate-900 min-w-[160px]" placeholder="Nombre de la tienda" value={newStoreName} onChange={e => setNewStoreName(e.target.value)} />
                <input className="w-32 border rounded-2xl p-3 text-sm bg-white text-slate-900" placeholder="Código" value={newStoreCode} onChange={e => setNewStoreCode(e.target.value)} />
                <button className="px-5 py-3 rounded-2xl bg-slate-900 text-white font-semibold text-sm" onClick={createStore}>+ Crear</button>
              </div>
            </div>
          )}
          <div className="border rounded-2xl overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-100">
                <tr>
                  <th className="p-2 border text-left">Nombre</th>
                  <th className="p-2 border">Código</th>
                  <th className="p-2 border">Estado</th>
                  <th className="p-2 border">Acción</th>
                </tr>
              </thead>
              <tbody>
                {allStores.map(s => (
                  <tr key={s.id} className={!s.is_active ? "opacity-40" : ""}>
                    <td className="p-2 border font-medium">{s.name}</td>
                    <td className="p-2 border text-center font-mono text-xs">{s.code}</td>
                    <td className="p-2 border text-center">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${s.is_active ? "bg-green-100 text-green-700" : "bg-slate-100 text-slate-500"}`}>{s.is_active ? "Activa" : "Inactiva"}</span>
                    </td>
                    <td className="p-2 border text-center">
                      <button className="text-xs underline text-slate-600" onClick={() => toggleStoreActive(s)}>{s.is_active ? "Desactivar" : "Activar"}</button>
                    </td>
                  </tr>
                ))}
                {allStores.length === 0 && <tr><td colSpan={4} className="p-6 text-center text-slate-400">No hay tiendas.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── ADMIN: USUARIOS ───────────────────────────────── */}
      {adminTab === "usuarios" && (
        <UsersModule stores={allStores} showMessage={showMessage} />
      )}

      {/* ── MODAL: EDITAR PRODUCTO ────────────────────────── */}
      {editingProduct && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center overflow-y-auto p-3 sm:p-4 z-50">
          <div className="app-modal-panel bg-white rounded-3xl p-5 w-full max-w-md space-y-4 shadow-2xl sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-xl font-bold text-slate-900">Editar producto</h3>
                <p className="text-slate-600 text-sm">{editingProduct.sku}</p>
              </div>
              <button className="text-slate-400 hover:text-slate-600 text-2xl leading-none" onClick={() => setEditingProduct(null)}>×</button>
            </div>
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="block font-semibold text-sm mb-1 text-slate-900">SKU</label>
                <input className="w-full border rounded-2xl p-3 text-slate-900 bg-white" value={editProdSku} onChange={e => setEditProdSku(e.target.value)} />
              </div>
              <div>
                <label className="block font-semibold text-sm mb-1 text-slate-900">Código de barra</label>
                <input className="w-full border rounded-2xl p-3 font-mono text-slate-900 bg-white" value={editProdBarcode} onChange={e => setEditProdBarcode(e.target.value)} placeholder="Opcional" />
              </div>
              <div className="md:col-span-2">
                <label className="block font-semibold text-sm mb-1 text-slate-900">Descripción</label>
                <input className="w-full border rounded-2xl p-3 text-slate-900 bg-white" value={editProdDesc} onChange={e => setEditProdDesc(e.target.value)} />
              </div>
              <div>
                <label className="block font-semibold text-sm mb-1 text-slate-900">Unidad de medida</label>
                <input className="w-full border rounded-2xl p-3 text-slate-900 bg-white" value={editProdUnit} onChange={e => setEditProdUnit(e.target.value)} />
              </div>
              <div>
                <label className="block font-semibold text-sm mb-1 text-slate-900">Costo unitario</label>
                <input className="w-full border rounded-2xl p-3 text-slate-900 bg-white" type="number" value={editProdCost} onChange={e => setEditProdCost(e.target.value)} />
              </div>
            </div>
            <div className="flex gap-3 pt-1">
              <button className="flex-1 py-3 rounded-2xl bg-slate-900 text-white font-semibold" onClick={saveEditProduct}>Guardar cambios</button>
              <button className="px-5 py-3 rounded-2xl border font-semibold text-slate-700" onClick={() => setEditingProduct(null)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
