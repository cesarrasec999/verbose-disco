import { NextResponse } from "next/server";

// Aplica de forma idempotente los indices que sostienen el reporte. La
// migracion equivalente se conserva en supabase/migrations para los futuros
// entornos; este endpoint permite prepararlos tambien en produccion.
export const maxDuration = 60;

export async function POST() {
  const ref = process.env.SUPABASE_PROJECT_REF;
  const token = process.env.SUPABASE_MANAGEMENT_TOKEN;
  if (!ref || !token) {
    return NextResponse.json({ error: "Falta configurar SUPABASE_PROJECT_REF / SUPABASE_MANAGEMENT_TOKEN en el servidor." }, { status: 500 });
  }

  const query = `
    CREATE INDEX IF NOT EXISTS idx_product_rotation_monthly_store_sku_period
      ON public.product_rotation_monthly (store_key, upper(btrim(product_code)), period_month DESC)
      INCLUDE (rotation_category);
    CREATE INDEX IF NOT EXISTS idx_cyclic_products_active_normalized_sku
      ON public.cyclic_products (upper(btrim(sku)))
      INCLUDE (cost)
      WHERE is_active = true;
  `;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55_000);
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) return NextResponse.json({ error: `Management API ${res.status}: ${text}` }, { status: 502 });
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    clearTimeout(timer);
  }
}
