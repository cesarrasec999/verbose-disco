import { NextResponse } from "next/server";

// Endpoint operativo temporal para aplicar una migracion de ubicaciones usando
// la Management API, sin exponer el token administrativo al navegador.
export async function POST(request: Request) {
  const guard = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const token = process.env.SUPABASE_MANAGEMENT_TOKEN;
  const ref = process.env.SUPABASE_PROJECT_REF;
  if (!guard || !token || !ref || request.headers.get("x-location-migration-token") !== guard) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }
  const body = await request.json().catch(() => null) as { query?: unknown } | null;
  const query = typeof body?.query === "string" ? body.query : "";
  if (!query.includes("validate_cd_gpc_location_format") || query.length > 100_000) {
    return NextResponse.json({ error: "Migracion no reconocida." }, { status: 400 });
  }
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const text = await response.text();
  return new NextResponse(text, { status: response.status, headers: { "Content-Type": "application/json" } });
}
