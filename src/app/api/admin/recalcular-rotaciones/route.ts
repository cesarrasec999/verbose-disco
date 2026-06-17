import { NextResponse } from "next/server";

// Necesita varios minutos en algunos casos; en plan Hobby de Vercel el
// limite real puede ser menor (10-60s) y este valor quedaria recortado.
// El mecanismo confiable es el watchdog del servidor (corre diario); este
// boton es un atajo manual best-effort, no la via principal.
export const maxDuration = 170;

// calculate_product_rotation() tarda mas que el limite (~30s) de la Data API
// de Supabase, asi que se ejecuta via la Management API (sin ese limite).
// El token nunca se expone al cliente: este endpoint corre server-side.
export async function POST(request: Request) {
  const ref = process.env.SUPABASE_PROJECT_REF;
  const token = process.env.SUPABASE_MANAGEMENT_TOKEN;
  if (!ref || !token) {
    return NextResponse.json({ error: "Falta configurar SUPABASE_PROJECT_REF / SUPABASE_MANAGEMENT_TOKEN en el servidor." }, { status: 500 });
  }

  const body = await request.json().catch(() => null);
  const periodMonth = String(body?.period_month || "");
  if (!/^\d{4}-\d{2}-01$/.test(periodMonth)) {
    return NextResponse.json({ error: "period_month invalido. Formato esperado: YYYY-MM-01." }, { status: 400 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 170_000);
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: `select calculate_product_rotation('${periodMonth}'::date);` }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json({ error: `Management API ${res.status}: ${text}` }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    clearTimeout(timer);
  }
}
