import { NextResponse } from "next/server";

// get_rotation_report() devuelve decenas de miles de filas: mas que el
// tope de 1000 filas por request que impone la Data API de Supabase
// (no ajustable con .range(), es un limite de plataforma), y tarda mas
// de los 3s de statement_timeout que tiene la clave anon del navegador.
// Se ejecuta server-side via la Management API (conexion administrativa
// directa, sin esos limites). El token nunca se expone al cliente.
export const maxDuration = 60;

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
  const timer = setTimeout(() => controller.abort(), 55_000);
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: `select * from get_rotation_report('${periodMonth}'::date);` }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json({ error: `Management API ${res.status}: ${text}` }, { status: 502 });
    }
    const rows = JSON.parse(text);
    return NextResponse.json({ rows });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    clearTimeout(timer);
  }
}
