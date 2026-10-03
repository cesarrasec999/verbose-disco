import { createHash, randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { validatePurchaseOrderIdentity } from "@/lib/server/purchaseOrderAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "purchase-order-signatures";
const MAX_BYTES = 2 * 1024 * 1024;
const ROLE_ORDER = ["purchasing_lead", "purchasing_manager", "finance_manager", "treasury_lead"];

function identityFromHeaders(request: NextRequest) {
  return {
    userId: request.headers.get("x-user-id") || "",
    sessionToken: request.headers.get("x-session-token"),
    deviceId: request.headers.get("x-device-id"),
  };
}

function errorResponse(error: unknown, status = 400) {
  const message = error instanceof Error ? error.message : "No se pudo procesar la firma";
  return NextResponse.json({ error: message }, { status });
}

function inspectPng(bytes: Buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)) {
    throw new Error("La firma debe enviarse como PNG");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const colorType = bytes.readUInt8(25);
  if (width < 300 || height < 100) throw new Error("La firma debe medir al menos 300 x 100 px");
  if (width > 5000 || height > 2500) throw new Error("La imagen es demasiado grande");
  if (![4, 6].includes(colorType)) throw new Error("El PNG debe admitir transparencia (fondo transparente)");
  return { width, height };
}

export async function GET(request: NextRequest) {
  try {
    const { supabase } = await validatePurchaseOrderIdentity(identityFromHeaders(request), { requireAdmin: true });
    const [{ data: assignments, error: assignmentsError }, { data: signatures, error: signaturesError }] = await Promise.all([
      supabase.from("purchase_order_approvers").select("role_key,user_id,is_active").eq("is_active", true),
      supabase.from("purchase_order_approval_signatures").select("user_id,storage_path,original_filename,file_size,sha256,uploaded_at,updated_at"),
    ]);
    if (assignmentsError) throw assignmentsError;
    if (signaturesError) throw signaturesError;

    const userIds = (assignments || []).map(row => row.user_id);
    const { data: users, error: usersError } = userIds.length
      ? await supabase.from("cyclic_users").select("id,full_name,username,is_active").in("id", userIds)
      : { data: [], error: null };
    if (usersError) throw usersError;

    const userMap = new Map((users || []).map(row => [row.id, row]));
    const signatureMap = new Map((signatures || []).map(row => [row.user_id, row]));
    const result = await Promise.all((assignments || [])
      .sort((a, b) => ROLE_ORDER.indexOf(a.role_key) - ROLE_ORDER.indexOf(b.role_key))
      .map(async assignment => {
        const user = userMap.get(assignment.user_id);
        const signature = signatureMap.get(assignment.user_id);
        let previewUrl: string | null = null;
        if (signature?.storage_path) {
          const { data } = await supabase.storage.from(BUCKET).createSignedUrl(signature.storage_path, 10 * 60);
          previewUrl = data?.signedUrl || null;
        }
        return { ...assignment, user, signature: signature ? { ...signature, preview_url: previewUrl } : null };
      }));

    return NextResponse.json({ approvers: result });
  } catch (error) {
    return errorResponse(error, 403);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { supabase, user } = await validatePurchaseOrderIdentity(identityFromHeaders(request), { requireAdmin: true });
    const form = await request.formData();
    const targetUserId = String(form.get("userId") || "").trim();
    const file = form.get("file");
    if (!targetUserId) throw new Error("Selecciona el aprobador");
    if (!(file instanceof File)) throw new Error("Selecciona un archivo PNG");
    if (file.size <= 0 || file.size > MAX_BYTES) throw new Error("La firma debe pesar como maximo 2 MB");

    const { data: assignment, error: assignmentError } = await supabase
      .from("purchase_order_approvers")
      .select("user_id")
      .eq("user_id", targetUserId)
      .eq("is_active", true)
      .maybeSingle();
    if (assignmentError || !assignment) throw new Error("El usuario no es un aprobador activo");

    const bytes = Buffer.from(await file.arrayBuffer());
    const dimensions = inspectPng(bytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const storagePath = `signatures/${targetUserId}/${randomUUID()}.png`;
    const { data: existing } = await supabase
      .from("purchase_order_approval_signatures")
      .select("storage_path")
      .eq("user_id", targetUserId)
      .maybeSingle();

    const { error: uploadError } = await supabase.storage.from(BUCKET).upload(storagePath, bytes, {
      contentType: "image/png",
      upsert: false,
      cacheControl: "3600",
    });
    if (uploadError) throw uploadError;

    const { error: saveError } = await supabase.from("purchase_order_approval_signatures").upsert({
      user_id: targetUserId,
      storage_path: storagePath,
      original_filename: file.name || "firma.png",
      mime_type: "image/png",
      file_size: file.size,
      sha256: hash,
      uploaded_by: user.id,
      uploaded_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    if (saveError) {
      await supabase.storage.from(BUCKET).remove([storagePath]);
      throw saveError;
    }
    if (existing?.storage_path && existing.storage_path !== storagePath) {
      await supabase.storage.from(BUCKET).remove([existing.storage_path]);
    }

    return NextResponse.json({ ok: true, dimensions, sha256: hash });
  } catch (error) {
    return errorResponse(error, 400);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { supabase } = await validatePurchaseOrderIdentity(identityFromHeaders(request), { requireAdmin: true });
    const targetUserId = request.nextUrl.searchParams.get("userId") || "";
    const { data: existing, error: findError } = await supabase
      .from("purchase_order_approval_signatures")
      .select("storage_path")
      .eq("user_id", targetUserId)
      .maybeSingle();
    if (findError) throw findError;
    if (!existing) return NextResponse.json({ ok: true });
    const { error: removeError } = await supabase.storage.from(BUCKET).remove([existing.storage_path]);
    if (removeError) throw removeError;
    const { error: deleteError } = await supabase.from("purchase_order_approval_signatures").delete().eq("user_id", targetUserId);
    if (deleteError) throw deleteError;
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, 400);
  }
}
