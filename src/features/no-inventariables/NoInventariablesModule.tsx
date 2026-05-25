"use client";

import { useMemo, useRef, useState } from "react";
import { Download, Search } from "lucide-react";
import * as XLSX from "xlsx";
import type { NonInventoryProduct, Product, CyclicUser } from "@/features/ciclicos/types";
import { formatMoney, fullProductCode, todayISO } from "@/features/ciclicos/utils";
import { readSafeSheetMatrix } from "@/lib/safeExcel";
import { supabase } from "@/lib/supabase/client";
import { deactivateNonInventoryCode, fetchNonInventoryProducts, saveNonInventoryCodes } from "./api";

type Props = {
  user: CyclicUser | null;
  products: NonInventoryProduct[];
  assignResults: Product[];
  onProductsChange: (products: NonInventoryProduct[]) => void;
  onAssignResultsChange: (updater: (products: Product[]) => Product[]) => void;
  onAssignSelectedIdsChange: (updater: (ids: Set<string>) => Set<string>) => void;
  showMessage: (text: string, type?: "info" | "success" | "error") => void;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function NoInventariablesModule({
  user,
  products,
  assignResults,
  onProductsChange,
  onAssignResultsChange,
  onAssignSelectedIdsChange,
  showMessage,
}: Props) {
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [excelBusy, setExcelBusy] = useState(false);
  const [excelFileName, setExcelFileName] = useState("");
  const excelRef = useRef<HTMLInputElement | null>(null);

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = products.filter((row) => {
      if (!q) return true;
      return [
        row.sku,
        row.barcode || "",
        row.product_description || row.description || "",
        row.unit || "",
      ].join(" ").toLowerCase().includes(q);
    });
    return rows.sort((a, b) => fullProductCode(a.sku).localeCompare(fullProductCode(b.sku)));
  }, [products, search]);

  async function reloadProducts() {
    onProductsChange(await fetchNonInventoryProducts(supabase));
  }

  async function saveCodes(codesRaw: Array<string | number | null | undefined>, sourceLabel = "manual") {
    try {
      const { saved, uniqueCodes } = await saveNonInventoryCodes(supabase, codesRaw, user);
      if (saved === 0) {
        showMessage("Ingresa al menos un codigo.", "error");
        return null;
      }

      await reloadProducts();
      onAssignResultsChange((prev) => prev.filter((product) => !uniqueCodes.includes(fullProductCode(product.sku))));
      onAssignSelectedIdsChange((prev) => new Set([...prev].filter((id) => !assignResults.some((product) => product.id === id && uniqueCodes.includes(fullProductCode(product.sku))))));
      showMessage(`✅ ${saved} codigo${saved !== 1 ? "s" : ""} marcado${saved !== 1 ? "s" : ""} como no inventariable${sourceLabel === "excel" ? " desde Excel" : ""}.`, "success");
      return saved;
    } catch (error: unknown) {
      showMessage("Error guardando no inventariables: " + errorMessage(error), "error");
      return null;
    }
  }

  async function addCodes() {
    const saved = await saveCodes(input.split(/[\n,;]+/), "manual");
    if (saved !== null) setInput("");
  }

  async function uploadExcel(file: File | null) {
    if (!file || excelBusy) return;
    setExcelBusy(true);
    setExcelFileName(file.name);
    try {
      const allRows = await readSafeSheetMatrix(file, { maxRows: 20000, maxCols: 10, raw: false });
      const firstCol = allRows.map((row) => String(row?.[0] ?? "").trim()).filter(Boolean);
      const header = firstCol[0]?.toLowerCase() || "";
      const hasHeader = ["codigo", "código", "codsap", "cod.sap", "sku", "producto"].some((label) => header.includes(label));
      const codes = hasHeader ? firstCol.slice(1) : firstCol;
      await saveCodes(codes, "excel");
    } catch (error: unknown) {
      showMessage("Error leyendo Excel de no inventariables: " + errorMessage(error), "error");
    } finally {
      setExcelBusy(false);
      if (excelRef.current) excelRef.current.value = "";
    }
  }

  async function removeCode(row: NonInventoryProduct) {
    try {
      await deactivateNonInventoryCode(supabase, row, user);
      await reloadProducts();
      showMessage("Codigo habilitado para asignacion.", "success");
    } catch (error: unknown) {
      showMessage("Error quitando no inventariable: " + errorMessage(error), "error");
    }
  }

  function exportProducts() {
    const rows = filteredProducts.map((row) => ({
      SKU: row.sku,
      BARRA: row.barcode || "",
      DESCRIPCION: row.product_description || row.description || "",
      UM: row.unit || "",
      COSTO: Number(row.cost || 0),
      ESTADO: row.is_active === false ? "Inactivo" : "Activo",
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "No inventariables");
    XLSX.writeFile(wb, `codigos_no_inventariables_${todayISO()}.xlsx`);
  }

  return (
    <section className="bg-white rounded-3xl p-5 shadow space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h3 className="text-lg font-bold text-slate-900">Codigos no inventariables</h3>
          <p className="text-slate-500 text-sm mt-1">Codigos excluidos de asignaciones ciclicas y cargas masivas.</p>
        </div>
        <button onClick={exportProducts} disabled={filteredProducts.length === 0} className="inline-flex items-center justify-center gap-2 rounded-xl bg-green-700 px-4 py-2 text-sm font-black text-white disabled:opacity-40">
          <Download size={16} /> Descargar Excel
        </button>
      </div>

      <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto_auto]">
        <input className="min-w-0 rounded-xl border bg-white px-3 py-3 text-sm text-slate-900" placeholder="Codsap exacto, uno o varios" value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void addCodes(); }} />
        <button onClick={addCodes} className="rounded-xl bg-orange-600 px-4 py-3 text-sm font-black text-white">Agregar</button>
        <button onClick={() => excelRef.current?.click()} disabled={excelBusy} className="rounded-xl border border-orange-300 bg-white px-4 py-3 text-sm font-black text-orange-700 disabled:opacity-50">
          {excelBusy ? "Subiendo..." : "Subir Excel"}
        </button>
        <input ref={excelRef} type="file" accept=".xlsx,.xls" className="hidden" onChange={(e) => void uploadExcel(e.target.files?.[0] || null)} />
      </div>
      {excelFileName && <p className="text-xs font-semibold text-orange-700">Ultimo Excel: {excelFileName}</p>}

      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 flex-1 items-center rounded-xl border bg-white px-3 py-2 md:max-w-xl">
          <Search size={16} className="shrink-0 text-slate-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar por codigo, barra, descripcion o UM" className="min-w-0 flex-1 px-2 text-sm outline-none" />
        </div>
        <div className="rounded-xl bg-slate-50 px-4 py-2 text-xs font-black text-slate-600">{filteredProducts.length} de {products.length} codigos</div>
      </div>

      <div className="overflow-auto rounded-2xl border">
        <table className="w-full min-w-[980px] text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="p-3 text-left">SKU</th>
              <th className="p-3 text-left">Barra</th>
              <th className="p-3 text-left">Descripcion</th>
              <th className="p-3 text-center">UM</th>
              <th className="p-3 text-right">Costo</th>
              <th className="p-3 text-center">Accion</th>
            </tr>
          </thead>
          <tbody>
            {filteredProducts.map((row) => (
              <tr key={row.id} className="border-t">
                <td className="p-3 font-mono text-xs font-black text-slate-900">{row.sku}</td>
                <td className="p-3 font-mono text-xs text-slate-500">{row.barcode || "-"}</td>
                <td className="max-w-xl p-3 text-slate-700">{row.product_description || row.description || "-"}</td>
                <td className="p-3 text-center font-semibold">{row.unit || "-"}</td>
                <td className="p-3 text-right font-semibold">{formatMoney(Number(row.cost || 0))}</td>
                <td className="p-3 text-center">
                  <button onClick={() => void removeCode(row)} className="rounded-xl border border-orange-300 bg-orange-50 px-3 py-2 text-xs font-black text-orange-700 hover:bg-orange-100">Habilitar</button>
                </td>
              </tr>
            ))}
            {filteredProducts.length === 0 && (
              <tr>
                <td colSpan={6} className="p-8 text-center text-sm font-semibold text-slate-400">No hay codigos no inventariables con ese filtro.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
