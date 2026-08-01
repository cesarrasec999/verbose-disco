"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, Flashlight, ImagePlus, Search, XCircle } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase/client";
import { canAccessModule } from "@/features/access/moduleAccess";
import { fetchDisabledModules, isModuleBlockedForUser } from "@/features/access/moduleFlags";
import ModuleDisabledScreen from "@/features/access/ModuleDisabledScreen";
import type { CyclicUser, Product, Store } from "@/features/ciclicos/types";
import { formatNumber, scannerPermissionMessage } from "@/features/ciclicos/utils";
import { fetchStockForStore, insertDifferenceReport, resolveProductCandidates, uploadDifferencePhoto } from "./api";
import { TabNav } from "./TabNav";

const SCANNER_CONTAINER_ID = "diferencias-scanner";

export default function ReportarTab() {
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [userLoaded, setUserLoaded] = useState(false);
  const [moduleDisabled, setModuleDisabled] = useState(false);
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState("");

  const [codeInput, setCodeInput] = useState("");
  const [searching, setSearching] = useState(false);
  const [candidates, setCandidates] = useState<Product[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [currentStock, setCurrentStock] = useState<number | null>(null);

  const [physicalQty, setPhysicalQty] = useState("");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const [scannerOpen, setScannerOpen] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const scannerRef = useRef<{ stop: () => Promise<void>; clear: () => void | Promise<void>; getState?: () => number; applyVideoConstraints?: (c: MediaTrackConstraints) => Promise<void> } | null>(null);
  const scannerBusyRef = useRef(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("cyclic_user");
      if (raw) setUser(JSON.parse(raw) as CyclicUser);
    } catch { setUser(null); }
    setUserLoaded(true);
  }, []);

  useEffect(() => {
    if (!user) return;
    fetchDisabledModules().then(disabled => {
      if (isModuleBlockedForUser(disabled, "inventory_differences", user)) setModuleDisabled(true);
    });
  }, [user]);

  useEffect(() => {
    supabase
      .from("stores")
      .select("id, code, name, is_active, erp_sede")
      .eq("is_active", true)
      .order("name")
      .then(({ data }) => setStores((data || []) as Store[]));
  }, []);

  useEffect(() => {
    if (!user || stores.length === 0 || selectedStoreId) return;
    if (user.store_id) setSelectedStoreId(user.store_id);
  }, [user, stores, selectedStoreId]);

  const selectedStore = stores.find(store => store.id === selectedStoreId) || null;

  async function searchCode(codeOverride?: string) {
    const code = (codeOverride ?? codeInput).trim();
    if (!code) return;
    if (!selectedStore) { toast.error("Selecciona una tienda antes de buscar un código."); return; }
    setSearching(true);
    try {
      const results = await resolveProductCandidates(code);
      if (results.length === 0) { toast.error(`Código ${code} no encontrado en el maestro.`); return; }
      if (results.length === 1) { await selectProduct(results[0]); return; }
      setCandidates(results);
    } catch (error) {
      toast.error("No se pudo buscar el código: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setSearching(false);
    }
  }

  async function selectProduct(product: Product) {
    if (!selectedStore) return;
    setCandidates([]);
    setSelectedProduct(product);
    setCurrentStock(null);
    setCodeInput("");
    try {
      const stock = await fetchStockForStore(selectedStore, product);
      setCurrentStock(stock);
    } catch (error) {
      toast.error("No se pudo leer el stock actual: " + (error instanceof Error ? error.message : String(error)));
      setSelectedProduct(null);
    }
  }

  function setPhoto(file: File | null) {
    setPhotoPreview(prev => { if (prev) URL.revokeObjectURL(prev); return file ? URL.createObjectURL(file) : ""; });
    setPhotoFile(file);
  }

  function resetForm() {
    setSelectedProduct(null);
    setCurrentStock(null);
    setPhysicalQty("");
    setPhoto(null);
    setNotes("");
  }

  async function submitReport() {
    if (!user || !selectedStore || !selectedProduct || currentStock === null) return;
    const qty = Number(physicalQty);
    if (!Number.isFinite(qty) || qty < 0) { toast.error("Ingresa una cantidad física válida."); return; }
    if (qty === currentStock) { toast.error("La cantidad física es igual al stock del sistema; no hay una diferencia para reportar."); return; }
    if (!photoFile) { toast.error("La foto es obligatoria."); return; }

    setSaving(true);
    try {
      const photoUrl = await uploadDifferencePhoto(photoFile);
      await insertDifferenceReport({
        store_id: selectedStore.id,
        store_name: selectedStore.name,
        product_id: selectedProduct.id,
        sku: selectedProduct.sku,
        description: selectedProduct.description,
        unit: selectedProduct.unit,
        system_stock_at_report: currentStock,
        physical_qty: qty,
        photo_url: photoUrl,
        notes: notes.trim() || null,
        operator_id: user.id,
        operator_name: user.full_name,
      });
      toast.success(`Reporte guardado: ${selectedProduct.sku}.`);
      resetForm();
    } catch (error) {
      toast.error("No se pudo guardar el reporte: " + (error instanceof Error ? error.message : String(error)));
    } finally {
      setSaving(false);
    }
  }

  async function stopScanner() {
    setScannerOpen(false);
    setTorchOn(false);
    try {
      if (scannerRef.current) {
        const state = scannerRef.current.getState?.();
        if (state !== 1) await scannerRef.current.stop();
        await scannerRef.current.clear();
      }
    } catch { /* noop */ }
    scannerRef.current = null;
    scannerBusyRef.current = false;
  }

  useEffect(() => {
    if (!scannerOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const { Html5Qrcode } = await import("html5-qrcode");
        if (cancelled) return;
        const scanner = new Html5Qrcode(SCANNER_CONTAINER_ID);
        scannerRef.current = scanner;
        scannerBusyRef.current = false;
        await scanner.start(
          { facingMode: "environment" },
          { fps: 15, qrbox: { width: 280, height: 190 }, aspectRatio: 1.6 },
          async (decodedText: string) => {
            if (scannerBusyRef.current) return;
            scannerBusyRef.current = true;
            await stopScanner();
            await searchCode(decodedText);
          },
          () => {}
        );
      } catch (error) {
        toast.error(scannerPermissionMessage(error));
        await stopScanner();
      }
    })();
    return () => { cancelled = true; void stopScanner(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scannerOpen]);

  async function toggleTorch() {
    try {
      const next = !torchOn;
      if (!scannerRef.current?.applyVideoConstraints) { toast.error("La linterna no está disponible en este dispositivo."); return; }
      await scannerRef.current.applyVideoConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch { /* noop */ }
  }

  if (!userLoaded) return null;
  if (!user || !canAccessModule(user, "inventory_differences")) {
    return <ModuleDisabledScreen moduleLabel="Diferencias de Inventario" reason="Tu usuario no tiene acceso a este módulo." />;
  }
  if (moduleDisabled) return <ModuleDisabledScreen moduleLabel="Diferencias de Inventario" />;
  if (!user.store_id) {
    return (
      <main className="mx-auto max-w-2xl p-4">
        <div className="rounded-2xl border bg-white p-6 text-center shadow-sm">
          <h1 className="text-lg font-black text-slate-900">Diferencias de Inventario</h1>
          <p className="mt-2 text-sm font-semibold text-slate-600">Tu usuario no tiene una tienda asignada para registrar diferencias.</p>
          <p className="mt-1 text-xs text-slate-400">Solicita al administrador asignarte una tienda y vuelve a ingresar.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl space-y-4 p-4 pb-24">
      <TabNav active="reportar" />

      <div className="rounded-xl border bg-slate-50 px-3 py-3 text-sm">
        <span className="font-black text-slate-500">Tienda de registro: </span>
        <span className="font-black text-slate-900">{selectedStore?.name || "Cargando tienda asignada..."}</span>
      </div>

      {!selectedProduct && (
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <h2 className="font-black">Buscar código</h2>
          <div className="mt-3 flex gap-2">
            <input
              value={codeInput}
              onChange={event => setCodeInput(event.target.value)}
              onKeyDown={event => { if (event.key === "Enter") void searchCode(); }}
              placeholder="Escanea o digita el código"
              className="min-w-0 flex-1 rounded-xl border px-3 py-3 text-sm font-bold"
            />
            <button onClick={() => setScannerOpen(true)} className="rounded-xl bg-slate-900 px-3 py-3 text-white" title="Escanear">
              <Camera size={18} />
            </button>
            <button onClick={() => void searchCode()} disabled={searching} className="rounded-xl bg-blue-700 px-3 py-3 text-white disabled:opacity-40" title="Buscar">
              <Search size={18} />
            </button>
          </div>
        </div>
      )}

      {candidates.length > 0 && (
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-black">Elige el código</h2>
            <button onClick={() => setCandidates([])} className="rounded-lg border px-3 py-1 text-sm font-bold">Cerrar</button>
          </div>
          <div className="space-y-2">
            {candidates.map(product => (
              <button
                key={product.id}
                onClick={() => void selectProduct(product)}
                className="w-full rounded-xl border p-3 text-left hover:border-blue-600 hover:bg-blue-50"
              >
                <div className="font-black text-slate-950">{product.sku}</div>
                <div className="text-sm text-slate-600">{product.description}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {selectedProduct && (
        <div className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-black uppercase text-slate-500">{selectedProduct.sku}</div>
              <div className="font-black text-slate-950">{selectedProduct.description}</div>
              <div className="mt-1 text-xs font-bold text-slate-500">UM: {selectedProduct.unit || "N/D"}</div>
            </div>
            <button onClick={resetForm} className="rounded-lg border p-2 text-slate-500" title="Cancelar">
              <XCircle size={18} />
            </button>
          </div>

          <div className="mt-3 rounded-xl bg-slate-50 p-3 text-center">
            <div className="text-xs font-black uppercase text-slate-500">Stock actual del sistema</div>
            <div className="text-2xl font-black text-slate-950">
              {currentStock === null ? "Cargando..." : formatNumber(currentStock)}
            </div>
          </div>

          <div className="mt-4 space-y-3">
            <div>
              <label className="text-xs font-black uppercase text-slate-500">Cantidad física (obligatorio)</label>
              <input
                value={physicalQty}
                onChange={event => setPhysicalQty(event.target.value)}
                inputMode="decimal"
                type="number"
                min="0"
                placeholder="Cantidad que encontraste"
                className="mt-1 w-full rounded-xl border px-3 py-3 text-sm font-bold"
              />
            </div>

            <div>
              <label className="text-xs font-black uppercase text-slate-500">Foto (obligatorio)</label>
              <label className="mt-1 flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed p-4 text-sm font-bold text-slate-600 hover:bg-slate-50">
                <ImagePlus size={18} />
                {photoFile ? "Cambiar foto" : "Tomar / elegir foto"}
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={event => setPhoto(event.target.files?.[0] || null)}
                />
              </label>
              {photoPreview && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photoPreview} alt="Foto del reporte" className="mt-2 max-h-48 w-full rounded-xl object-cover" />
              )}
            </div>

            <div>
              <label className="text-xs font-black uppercase text-slate-500">Observación (opcional)</label>
              <textarea
                value={notes}
                onChange={event => setNotes(event.target.value)}
                placeholder="Detalle adicional..."
                className="mt-1 min-h-20 w-full rounded-xl border px-3 py-2 text-sm"
              />
            </div>
          </div>

          <button
            onClick={submitReport}
            disabled={saving}
            className="mt-4 w-full rounded-xl bg-green-700 px-4 py-3 text-sm font-black text-white disabled:opacity-40"
          >
            {saving ? "Guardando..." : "Guardar reporte"}
          </button>
        </div>
      )}

      {scannerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-3 sm:p-4">
          <div className="app-modal-panel w-full max-w-lg rounded-2xl bg-white p-4 shadow-2xl">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-black">Escanear producto</h3>
              <div className="flex gap-2">
                <button onClick={toggleTorch} className={`rounded-lg border px-3 py-2 text-sm font-black ${torchOn ? "bg-yellow-400 text-slate-900" : "bg-slate-900 text-white"}`} title="Prender linterna">
                  <Flashlight className="mr-2 inline" size={18} /> Linterna
                </button>
                <button onClick={() => void stopScanner()} className="rounded-lg border px-3 py-2 text-sm font-black">
                  Cerrar
                </button>
              </div>
            </div>
            <div className="overflow-hidden rounded-xl bg-black">
              <div id={SCANNER_CONTAINER_ID} className="min-h-[280px] w-full" />
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
