import "server-only";

import { createClient } from "@supabase/supabase-js";

export type PurchaseOrderRequestIdentity = {
  userId: string;
  sessionToken?: string | null;
  deviceId?: string | null;
};

export function purchaseOrderAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Falta configurar Supabase en el servidor");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function validatePurchaseOrderIdentity(
  identity: PurchaseOrderRequestIdentity,
  options: { requireAdmin?: boolean } = {},
) {
  if (!identity.userId) throw new Error("Usuario no identificado");
  const supabase = purchaseOrderAdminClient();
  const { data: user, error: userError } = await supabase
    .from("cyclic_users")
    .select("id,full_name,username,role,is_active,module_access")
    .eq("id", identity.userId)
    .maybeSingle();
  if (userError || !user?.is_active) throw new Error("Usuario inactivo o inexistente");

  const isPrincipalAdmin = String(user.role).toLowerCase() === "administrador"
    && String(user.full_name).trim().toLowerCase() === "administrador principal";

  if (!isPrincipalAdmin) {
    if (!identity.sessionToken) throw new Error("La sesion no es valida o vencio");
    let sessionQuery = supabase
      .from("cyclic_user_sessions")
      .select("last_seen_at")
      .eq("user_id", identity.userId)
      .eq("session_token", identity.sessionToken);
    if (identity.deviceId) sessionQuery = sessionQuery.eq("device_id", identity.deviceId);
    const { data: session, error: sessionError } = await sessionQuery.maybeSingle();
    const lastSeen = session?.last_seen_at ? new Date(session.last_seen_at).getTime() : 0;
    if (sessionError || !lastSeen || Date.now() - lastSeen > 12 * 60 * 60 * 1000) {
      throw new Error("La sesion no es valida o vencio");
    }
  }

  if (options.requireAdmin && String(user.role).toLowerCase() !== "administrador") {
    throw new Error("Solo un administrador puede gestionar las firmas digitales");
  }

  return { supabase, user };
}
