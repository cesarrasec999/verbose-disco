import type { SupabaseClient } from "@supabase/supabase-js";
import type { CyclicUser, NonInventoryProduct, Product } from "@/features/ciclicos/types";
import { fullProductCode } from "@/features/ciclicos/utils";

type NonInventoryProductRow = {
  id: string;
  product_id: string | null;
  sku: string;
  description: string | null;
  is_active: boolean;
  cyclic_products?: {
    sku?: string | null;
    barcode?: string | null;
    description?: string | null;
    unit?: string | null;
    cost?: number | null;
  } | null;
};

export async function fetchNonInventoryProducts(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("cyclic_non_inventory_products")
    .select("id, product_id, sku, description, is_active, cyclic_products(sku, barcode, description, unit, cost)")
    .eq("is_active", true)
    .order("sku");

  if (error) throw error;

  return ((data || []) as NonInventoryProductRow[]).map((row) => ({
    id: row.id,
    product_id: row.product_id,
    sku: row.cyclic_products?.sku || row.sku,
    description: row.description,
    is_active: row.is_active,
    barcode: row.cyclic_products?.barcode || null,
    unit: row.cyclic_products?.unit || null,
    cost: row.cyclic_products?.cost ?? null,
    product_description: row.cyclic_products?.description || row.description || null,
  })) as NonInventoryProduct[];
}

export async function saveNonInventoryCodes(
  supabase: SupabaseClient,
  codesRaw: Array<string | number | null | undefined>,
  user: Pick<CyclicUser, "id"> | null
) {
  const codes = codesRaw
    .map((code) => fullProductCode(code).toUpperCase())
    .filter(Boolean);
  const uniqueCodes = [...new Set(codes)];
  if (uniqueCodes.length === 0) return { saved: 0, uniqueCodes };

  const productsBySku = new Map<string, Product>();
  for (let i = 0; i < uniqueCodes.length; i += 500) {
    const chunk = uniqueCodes.slice(i, i + 500);
    const { data, error } = await supabase.from("cyclic_products").select("id, sku, barcode, description, unit, cost, is_active").in("sku", chunk).eq("is_active", true);
    if (error) throw error;
    for (const product of data || []) productsBySku.set(fullProductCode(product.sku), product as Product);
  }

  const rows = uniqueCodes.map((code) => {
    const product = productsBySku.get(code);
    return {
      product_id: product?.id || null,
      sku: product?.sku || code,
      description: product?.description || null,
      is_active: true,
      updated_at: new Date().toISOString(),
      updated_by: user?.id || null,
    };
  });

  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase
      .from("cyclic_non_inventory_products")
      .upsert(rows.slice(i, i + 500), { onConflict: "sku" });
    if (error) throw error;
  }

  return { saved: rows.length, uniqueCodes };
}

export async function deactivateNonInventoryCode(
  supabase: SupabaseClient,
  row: NonInventoryProduct,
  user: Pick<CyclicUser, "id"> | null
) {
  const { error } = await supabase
    .from("cyclic_non_inventory_products")
    .update({ is_active: false, updated_at: new Date().toISOString(), updated_by: user?.id || null })
    .eq("id", row.id);

  if (error) throw error;
}
