import { NextResponse } from "next/server";

// Endpoint temporal de mantenimiento; se elimina después de aplicar el SQL.
export async function POST(request: Request) {
  const guard = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!guard || request.headers.get("x-migration-key") !== guard) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const ref = process.env.SUPABASE_PROJECT_REF;
  const token = process.env.SUPABASE_MANAGEMENT_TOKEN;
  if (!ref || !token) return NextResponse.json({ error: "Missing management configuration" }, { status: 500 });
  const query = `CREATE OR REPLACE FUNCTION public.calculate_product_rotation(p_target_month date DEFAULT NULL) RETURNS void LANGUAGE plpgsql VOLATILE SET search_path = public AS $$ BEGIN PERFORM public.calculate_product_rotation_net_documents(COALESCE(p_target_month, date_trunc('month', current_date - interval '1 month')::date)); END; $$; GRANT EXECUTE ON FUNCTION public.calculate_product_rotation(date) TO service_role;`;
  try {
    const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const text = await response.text();
    if (!response.ok) return NextResponse.json({ error: text }, { status: 502 });
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
