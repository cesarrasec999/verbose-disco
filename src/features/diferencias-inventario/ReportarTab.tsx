"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { ImagePlus, Minus, Plus } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase/client";
import { canAccessModule } from "@/features/access/moduleAccess";
import { fetchDisabledModules, isModuleBlockedForUser } from "@/features/access/moduleFlags";
import ModuleDisabledScreen from "@/features/access/ModuleDisabledScreen";
import type { CyclicUser, Store } from "@/features/ciclicos/types";
import { formatNumber } from "@/features/ciclicos/utils";
import { fetchProvisionalPending, insertDifferenceReports, uploadDifferencePhoto } from "./api";
import { ProductSelector, type SelectedRequestProduct } from "./ProductSelector";
import { TabNav } from "./TabNav";
import type { DifferenceReason, RequestProductDetail } from "./types";

const REASONS: Array<{ value: DifferenceReason; label: string; help: string }> = [
  { value: "cruce_sku", label: "Cruce de SKU", help: "Un código sobra y otro falta." },
  { value: "ajuste_inventario", label: "Ajuste de inventario", help: "Diferencia urgente sin causa determinada." },
  { value: "post_inventario", label: "Post inventario", help: "Error luego de un inventario general." },
  { value: "ingreso_provisional", label: "Ingreso provisional", help: "Aumentar stock temporalmente para facturar." },
  { value: "regularizacion_provisional", label: "Regularización de provisional", help: "Regularizar un ingreso provisional pendiente." },
  { value: "transformacion_interna", label: "Transformación interna de productos", help: "Convertir códigos negativos en códigos positivos." },
];

type TransformRow = { id: string; selection: SelectedRequestProduct | null; quantity: string };
const newTransformRow = (): TransformRow => ({ id: crypto.randomUUID(), selection: null, quantity: "" });
const qty = (value: string) => Number(value);

function QuantityInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="block text-xs font-black uppercase text-slate-500">{label}<input value={value} onChange={event => onChange(event.target.value)} type="number" min="0" inputMode="decimal" className="mt-1 w-full rounded-xl border px-3 py-3 text-sm font-bold" /></label>;
}

export default function ReportarTab() {
  const [user, setUser] = useState<CyclicUser | null>(null);
  const [userLoaded, setUserLoaded] = useState(false);
  const [moduleDisabled, setModuleDisabled] = useState(false);
  const [stores, setStores] = useState<Store[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState("");
  const [reason, setReason] = useState<DifferenceReason | "">("");
  const [primary, setPrimary] = useState<SelectedRequestProduct | null>(null);
  const [cross, setCross] = useState<SelectedRequestProduct | null>(null);
  const [primaryQty, setPrimaryQty] = useState("");
  const [crossQty, setCrossQty] = useState("");
  const [requestedQty, setRequestedQty] = useState("");
  const [regularizationProcess, setRegularizationProcess] = useState<"Compras" | "Abastecimiento" | "">("");
  const [provisionalPending, setProvisionalPending] = useState<number | null>(null);
  const [negativeRows, setNegativeRows] = useState<TransformRow[]>([newTransformRow()]);
  const [positiveRows, setPositiveRows] = useState<TransformRow[]>([newTransformRow()]);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  const canReportAllStores = user?.role === "Administrador" || user?.role === "Supervisor" || user?.role === "Validador";
  const selectedStore = stores.find(store => store.id === selectedStoreId) || null;
  const selectedReason = REASONS.find(item => item.value === reason);

  useEffect(() => {
    try { const raw = localStorage.getItem("cyclic_user"); if (raw) setUser(JSON.parse(raw) as CyclicUser); } catch { setUser(null); }
    setUserLoaded(true);
  }, []);
  useEffect(() => { if (user) fetchDisabledModules().then(disabled => { if (isModuleBlockedForUser(disabled, "inventory_differences", user)) setModuleDisabled(true); }); }, [user]);
  useEffect(() => { supabase.from("stores").select("id,code,name,is_active,erp_sede").eq("is_active", true).order("name").then(({ data }) => setStores((data || []) as Store[])); }, []);
  useEffect(() => { if (user && !canReportAllStores && user.store_id) setSelectedStoreId(user.store_id); }, [user, canReportAllStores]);
  useEffect(() => {
    if (reason !== "regularizacion_provisional" || !primary || !selectedStore) { setProvisionalPending(null); return; }
    fetchProvisionalPending(selectedStore, primary.product).then(setProvisionalPending).catch(() => setProvisionalPending(null));
  }, [reason, primary, selectedStore]);

  function resetForm(nextReason: DifferenceReason | "" = reason) {
    setReason(nextReason); setPrimary(null); setCross(null); setPrimaryQty(""); setCrossQty(""); setRequestedQty(""); setRegularizationProcess(""); setProvisionalPending(null); setNegativeRows([newTransformRow()]); setPositiveRows([newTransformRow()]);
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoPreview(""); setPhotoFile(null); setNotes("");
  }
  function setPhoto(file: File | null) {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
    setPhotoFile(file); setPhotoPreview(file ? URL.createObjectURL(file) : "");
  }
  function updateTransform(kind: "negative" | "positive", id: string, patch: Partial<TransformRow>) {
    const setter = kind === "negative" ? setNegativeRows : setPositiveRows;
    setter(rows => rows.map(row => row.id === id ? { ...row, ...patch } : row));
  }
  function productDetail(role: RequestProductDetail["role"], value: SelectedRequestProduct, quantity: number): RequestProductDetail {
    return { role, product_id: value.product.id, sku: value.product.sku, description: value.product.description, unit: value.product.unit, system_stock: value.systemStock, quantity, cost: Number(value.product.cost || 0) };
  }

  async function submit() {
    if (!user || !selectedStore || !reason) { toast.error("Selecciona motivo y tienda antes de continuar."); return; }
    const requiresPrimary = reason !== "transformacion_interna";
    if (requiresPrimary && !primary) { toast.error("Selecciona el código principal."); return; }
    const primaryPhysical = qty(primaryQty);
    const requested = qty(requestedQty);
    let products: RequestProductDetail[] = [];
    let physicalQty: number | null = null;
    let primaryProduct = primary;
    let needsPhoto = false;

    if (reason === "cruce_sku") {
      if (!primary || !cross || !Number.isFinite(primaryPhysical) || primaryPhysical < 0 || !Number.isFinite(qty(crossQty)) || qty(crossQty) < 0) { toast.error("Completa ambos códigos y cantidades físicas."); return; }
      products = [productDetail("principal", primary, primaryPhysical), productDetail("cruce", cross, qty(crossQty))]; physicalQty = primaryPhysical; needsPhoto = true;
    } else if (reason === "ajuste_inventario" || reason === "post_inventario") {
      if (!primary || !Number.isFinite(primaryPhysical) || primaryPhysical < 0) { toast.error("Ingresa la cantidad física."); return; }
      if (primaryPhysical === primary.systemStock) { toast.error("La cantidad física coincide con el stock del sistema."); return; }
      products = [productDetail("principal", primary, primaryPhysical)]; physicalQty = primaryPhysical; needsPhoto = primaryPhysical > primary.systemStock;
    } else if (reason === "ingreso_provisional") {
      if (!primary || !Number.isFinite(requested) || requested <= 0 || !regularizationProcess || !notes.trim()) { toast.error("Completa código, cantidad solicitada, proceso de regularización y autorización en observaciones."); return; }
      products = [productDetail("principal", primary, requested)]; physicalQty = null;
    } else if (reason === "regularizacion_provisional") {
      if (!primary || !Number.isFinite(requested) || requested <= 0) { toast.error("Ingresa la cantidad a regularizar."); return; }
      if (provisionalPending !== null && requested > provisionalPending) { toast.error("La cantidad a regularizar no puede superar el saldo provisional pendiente."); return; }
      products = [productDetail("principal", primary, requested)]; physicalQty = null;
    } else {
      const negative = negativeRows.filter(row => row.selection && Number.isFinite(qty(row.quantity)) && qty(row.quantity) > 0) as Array<TransformRow & { selection: SelectedRequestProduct }>;
      const positive = positiveRows.filter(row => row.selection && Number.isFinite(qty(row.quantity)) && qty(row.quantity) > 0) as Array<TransformRow & { selection: SelectedRequestProduct }>;
      if (negative.length === 0 || positive.length === 0) { toast.error("Agrega al menos un código negativo y uno positivo con sus cantidades."); return; }
      products = [...negative.map(row => productDetail("negativo", row.selection, qty(row.quantity))), ...positive.map(row => productDetail("positivo", row.selection, qty(row.quantity)))];
      primaryProduct = negative[0].selection; physicalQty = null;
    }
    if (needsPhoto && !photoFile) { toast.error("La foto es obligatoria porque el producto está sobrando."); return; }
    setSaving(true);
    try {
      const photoUrl = photoFile ? await uploadDifferencePhoto(photoFile) : null;
      const requestData = { products, regularization_process: regularizationProcess || undefined, provisional_pending: reason === "regularizacion_provisional" ? provisionalPending : undefined, notes: notes.trim() || null };
      if (reason === "cruce_sku" && primary && cross) {
        // Un cruce representa dos productos, pero una sola atención y un solo
        // número de ajuste. Se guardan dos líneas vinculadas por el mismo grupo.
        const crossGroupId = crypto.randomUUID();
        await insertDifferenceReports([
          {
            store_id: selectedStore.id, store_name: selectedStore.name,
            product_id: primary.product.id, sku: primary.product.sku,
            description: primary.product.description, unit: primary.product.unit,
            system_stock_at_report: primary.systemStock, physical_qty: primaryPhysical, photo_url: photoUrl,
            notes: notes.trim() || null, reason,
            request_data: { ...requestData, cross_group_id: crossGroupId, cross_line_role: "principal" },
            operator_id: user.id, operator_name: user.full_name,
          },
          {
            store_id: selectedStore.id, store_name: selectedStore.name,
            product_id: cross.product.id, sku: cross.product.sku,
            description: cross.product.description, unit: cross.product.unit,
            system_stock_at_report: cross.systemStock, physical_qty: qty(crossQty), photo_url: null,
            notes: notes.trim() || null, reason,
            request_data: { ...requestData, cross_group_id: crossGroupId, cross_line_role: "cruce" },
            operator_id: user.id, operator_name: user.full_name,
          },
        ]);
      } else {
        await insertDifferenceReports([{
          store_id: selectedStore.id, store_name: selectedStore.name,
          product_id: primaryProduct?.product.id || null, sku: primaryProduct?.product.sku || products[0].sku,
          description: primaryProduct?.product.description || products[0].description, unit: primaryProduct?.product.unit || products[0].unit,
          system_stock_at_report: primaryProduct?.systemStock || 0, physical_qty: physicalQty, photo_url: photoUrl,
          notes: notes.trim() || null, reason, request_data: requestData,
          operator_id: user.id, operator_name: user.full_name,
        }]);
      }
      toast.success("Solicitud registrada. Podrás ver cuando sea atendida en Resumen.");
      resetForm();
    } catch (error) { toast.error("No se pudo guardar: " + (error instanceof Error ? error.message : String(error))); }
    finally { setSaving(false); }
  }

  const showPhoto = reason === "cruce_sku" || reason === "ajuste_inventario" || reason === "post_inventario";
  const photoRequired = reason === "cruce_sku" || ((reason === "ajuste_inventario" || reason === "post_inventario") && primaryQty !== "" && primary && qty(primaryQty) > primary.systemStock);
  const transformSection = (kind: "negative" | "positive", title: string, rows: TransformRow[], setRows: Dispatch<SetStateAction<TransformRow[]>>) => <section className="space-y-3 rounded-2xl border bg-slate-50 p-3"><div className="flex items-center justify-between"><h3 className="font-black text-slate-900">{title}</h3><button type="button" onClick={() => setRows(prev => [...prev, newTransformRow()])} className="inline-flex items-center gap-1 rounded-lg border bg-white px-2 py-1 text-xs font-black"><Plus size={14} /> Agregar</button></div>{rows.map((row, index) => <div key={row.id} className="rounded-xl bg-white p-3 shadow-sm"><div className="mb-2 flex justify-between"><span className="text-xs font-black text-slate-500">Código {index + 1}</span>{rows.length > 1 && <button type="button" onClick={() => setRows(prev => prev.filter(item => item.id !== row.id))} className="text-red-600"><Minus size={16} /></button>}</div><ProductSelector label="Código" store={selectedStore} value={row.selection} onChange={selection => updateTransform(kind, row.id, { selection })} /><div className="mt-2"><QuantityInput label="Cantidad a convertir" value={row.quantity} onChange={value => updateTransform(kind, row.id, { quantity: value })} /></div></div>)}</section>;

  if (!userLoaded) return null;
  if (!user || !canAccessModule(user, "inventory_differences")) return <ModuleDisabledScreen moduleLabel="Diferencias de Inventario" reason="Tu usuario no tiene acceso a este módulo." />;
  if (moduleDisabled) return <ModuleDisabledScreen moduleLabel="Diferencias de Inventario" />;
  if (!canReportAllStores && !user.store_id) return <main className="mx-auto max-w-2xl p-4"><div className="rounded-2xl border bg-white p-6 text-center shadow-sm"><h1 className="text-lg font-black">Diferencias de Inventario</h1><p className="mt-2 text-sm text-slate-600">Tu usuario no tiene una tienda asignada para registrar solicitudes.</p></div></main>;

  return <main className="mx-auto max-w-3xl space-y-4 p-4 pb-24"><TabNav active="reportar" />
    <section className="rounded-2xl border bg-white p-4 shadow-sm"><label className="text-xs font-black uppercase text-slate-500">Motivo de la solicitud</label><select value={reason} onChange={event => resetForm(event.target.value as DifferenceReason | "")} className="mt-1 w-full rounded-xl border px-3 py-3 text-sm font-bold"><option value="">Selecciona un motivo</option>{REASONS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select>{selectedReason && <p className="mt-2 text-sm text-slate-500">{selectedReason.help}</p>}</section>
    {canReportAllStores ? <select value={selectedStoreId} onChange={event => { setSelectedStoreId(event.target.value); resetForm(reason); }} className="w-full rounded-xl border bg-white px-3 py-3 text-sm font-bold"><option value="">Selecciona la tienda para registrar</option>{stores.map(store => <option key={store.id} value={store.id}>{store.name}</option>)}</select> : <div className="rounded-xl border bg-slate-50 px-3 py-3 text-sm"><b className="text-slate-500">Tienda de registro: </b><b>{selectedStore?.name || "Cargando tienda asignada..."}</b></div>}
    {reason && selectedStore && <section className="space-y-4 rounded-2xl border bg-white p-4 shadow-sm">
      {reason !== "transformacion_interna" && <ProductSelector label="Código" store={selectedStore} value={primary} onChange={setPrimary} />}
      {primary && (reason === "cruce_sku" || reason === "ajuste_inventario" || reason === "post_inventario") && <QuantityInput label="Cantidad física" value={primaryQty} onChange={setPrimaryQty} />}
      {reason === "cruce_sku" && <><div className="border-t pt-4"><ProductSelector label="Código con el que se cruza" store={selectedStore} value={cross} onChange={setCross} /></div>{cross && <QuantityInput label="Cantidad física del código con el que se cruza" value={crossQty} onChange={setCrossQty} />}</>}
      {reason === "ingreso_provisional" && <><QuantityInput label="Cantidad solicitada" value={requestedQty} onChange={setRequestedQty} /><label className="block text-xs font-black uppercase text-slate-500">Proceso que regularizará el provisional<select value={regularizationProcess} onChange={event => setRegularizationProcess(event.target.value as "Compras" | "Abastecimiento" | "")} className="mt-1 w-full rounded-xl border px-3 py-3 text-sm font-bold"><option value="">Selecciona proceso</option><option>Compras</option><option>Abastecimiento</option></select></label></>}
      {reason === "regularizacion_provisional" && <><QuantityInput label="Cantidad a regularizar" value={requestedQty} onChange={setRequestedQty} /><div className="rounded-xl bg-amber-50 p-3 text-sm"><b>Saldo provisional pendiente: </b>{provisionalPending === null ? "Consultando..." : formatNumber(provisionalPending)}</div></>}
      {reason === "transformacion_interna" && <div className="grid gap-4 lg:grid-cols-2">{transformSection("negative", "Códigos a convertir en negativo", negativeRows, setNegativeRows)}{transformSection("positive", "Códigos a convertir en positivo", positiveRows, setPositiveRows)}</div>}
      {showPhoto && <div><label className="text-xs font-black uppercase text-slate-500">Foto {photoRequired ? "(obligatoria)" : "(opcional si es faltante)"}</label><label className="mt-1 flex cursor-pointer items-center justify-center gap-2 rounded-xl border-2 border-dashed p-4 text-sm font-bold text-slate-600"><ImagePlus size={18} />{photoFile ? "Cambiar foto" : "Tomar / elegir foto"}<input type="file" accept="image/*" capture="environment" className="hidden" onChange={event => setPhoto(event.target.files?.[0] || null)} /></label>{photoPreview && <img src={photoPreview} alt="Evidencia" className="mt-2 max-h-52 w-full rounded-xl object-cover" />}</div>}
      {(reason === "ingreso_provisional" || reason === "ajuste_inventario" || reason === "post_inventario") && <label className="block text-xs font-black uppercase text-slate-500">Observaciones {reason === "ingreso_provisional" ? "(obligatorio: indicar autorización)" : "(opcional)"}<textarea value={notes} onChange={event => setNotes(event.target.value)} className="mt-1 min-h-20 w-full rounded-xl border px-3 py-2 text-sm" placeholder={reason === "ingreso_provisional" ? "Indica quién autoriza la solicitud..." : "Detalle adicional..."} /></label>}
      <button type="button" onClick={() => void submit()} disabled={saving} className="w-full rounded-xl bg-green-700 px-4 py-3 text-sm font-black text-white disabled:opacity-40">{saving ? "Guardando..." : "Registrar solicitud"}</button>
    </section>}
  </main>;
}
