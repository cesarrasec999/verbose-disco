import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { validatePurchaseOrderIdentity } from "@/lib/server/purchaseOrderAuth";
import { buildPurchaseOrderPdf, type PdfApprovalStep } from "@/lib/server/purchaseOrderPdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIGNATURE_BUCKET = "purchase-order-signatures";
const DOCUMENT_BUCKET = "purchase-order-documents";

function identityFromHeaders(request: NextRequest) {
  return {
    userId: request.headers.get("x-user-id") || "",
    sessionToken: request.headers.get("x-session-token"),
    deviceId: request.headers.get("x-device-id"),
  };
}

function pdfResponse(bytes: Uint8Array, poNumber: string, cached: boolean) {
  const safeNumber = String(poNumber || "orden-compra").replace(/[^a-zA-Z0-9_-]/g, "-");
  return new NextResponse(Buffer.from(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="OC-${safeNumber}.pdf"`,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "X-RASECORP-PDF": cached ? "archived" : "preview",
    },
  });
}

function errorResponse(error: unknown, status = 400) {
  const message = error instanceof Error ? error.message : "No se pudo generar el PDF";
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: NextRequest, context: { params: Promise<{ erpPoId: string }> }) {
  try {
    const { erpPoId } = await context.params;
    const { supabase, user } = await validatePurchaseOrderIdentity(identityFromHeaders(request));
    const { data: order, error: orderError } = await supabase
      .from("erp_purchase_orders")
      .select("erp_po_id,po_number,po_no,business_status,store_no,store_code,store_name,vendor_code,vendor_name,buyer,po_date,ship_date,cancel_date,notes,qty_ordered,qty_received,total,currency_id")
      .eq("erp_po_id", erpPoId)
      .maybeSingle();
    if (orderError) throw orderError;
    if (!order) return errorResponse(new Error("La orden de compra no existe"), 404);

    const { data: routes, error: routeError } = await supabase
      .from("purchase_order_approval_routes")
      .select("id,version,route_kind,approval_tier,currency_code,amount_snapshot,status,created_at,approved_at,rejected_at,rejected_comment")
      .eq("erp_po_id", erpPoId)
      .order("version", { ascending: false })
      .limit(1);
    if (routeError) throw routeError;
    const route = routes?.[0] || null;

    const role = String(user.role || "").trim().toLowerCase();
    const isAdmin = role === "administrador" || role === "supervisor";
    let steps: PdfApprovalStep[] = [];
    if (route) {
      const { data, error } = await supabase
        .from("purchase_order_approval_steps")
        .select("id,step_order,role_key,approver_user_id,approver_name_snapshot,status,acted_at,comment")
        .eq("approval_id", route.id)
        .order("step_order");
      if (error) throw error;
      steps = (data || []) as PdfApprovalStep[];
    }
    const belongsToRoute = steps.some(step => step.approver_user_id === user.id);
    if (!isAdmin && !belongsToRoute) return errorResponse(new Error("No tienes permiso para ver esta orden de compra"), 403);

    if (route?.status === "approved") {
      const { data: archived, error: archiveError } = await supabase
        .from("purchase_order_pdf_documents")
        .select("storage_path")
        .eq("approval_id", route.id)
        .maybeSingle();
      if (archiveError) throw archiveError;
      if (archived?.storage_path) {
        const { data, error } = await supabase.storage.from(DOCUMENT_BUCKET).download(archived.storage_path);
        if (!error && data) return pdfResponse(new Uint8Array(await data.arrayBuffer()), order.po_number, true);
      }
    }

    const { data: lines, error: linesError } = await supabase
      .from("erp_purchase_order_lines")
      .select("line_id,product_code,description,unit,qty_ordered,cost,ext_cost")
      .eq("erp_po_id", erpPoId)
      .order("line_id");
    if (linesError) throw linesError;

    const approvedUserIds = steps.filter(step => step.status === "approved" && step.approver_user_id).map(step => step.approver_user_id as string);
    const signatureSnapshots: Array<{ user_id: string; sha256: string; storage_path: string }> = [];
    if (approvedUserIds.length) {
      const { data: signatures, error: signaturesError } = await supabase
        .from("purchase_order_approval_signatures")
        .select("user_id,storage_path,sha256")
        .in("user_id", approvedUserIds);
      if (signaturesError) throw signaturesError;
      const signaturesByUser = new Map((signatures || []).map(signature => [signature.user_id, signature]));
      await Promise.all(steps.map(async step => {
        if (step.status !== "approved" || !step.approver_user_id) return;
        const signature = signaturesByUser.get(step.approver_user_id);
        if (!signature) return;
        const { data, error } = await supabase.storage.from(SIGNATURE_BUCKET).download(signature.storage_path);
        if (error || !data) return;
        step.signature = { bytes: new Uint8Array(await data.arrayBuffer()), sha256: signature.sha256 };
        signatureSnapshots.push({ user_id: step.approver_user_id, sha256: signature.sha256, storage_path: signature.storage_path });
      }));
    }

    const allApprovedSignaturesReady = route?.status === "approved"
      && steps.filter(step => step.status === "approved").every(step => Boolean(step.signature));
    const generatedAt = new Date();
    const logoBytes = new Uint8Array(await readFile(path.join(process.cwd(), "public", "rms", "gpc-logo.png")));
    const bytes = await buildPurchaseOrderPdf({
      order,
      lines: lines || [],
      route,
      steps,
      logoBytes,
      allSignaturesReady: allApprovedSignaturesReady,
      generatedAt,
    });
    if (route?.status === "approved" && allApprovedSignaturesReady) {
      const storagePath = `orders/${route.id}/v${route.version}.pdf`;
      const hash = createHash("sha256").update(bytes).digest("hex");
      const { error: uploadError } = await supabase.storage.from(DOCUMENT_BUCKET).upload(storagePath, bytes, {
        contentType: "application/pdf",
        cacheControl: "31536000",
        upsert: true,
      });
      if (uploadError) throw uploadError;
      const { error: evidenceError } = await supabase.from("purchase_order_pdf_documents").upsert({
        approval_id: route.id,
        erp_po_id: erpPoId,
        approval_version: route.version,
        storage_path: storagePath,
        sha256: hash,
        file_size: bytes.length,
        signature_snapshot: signatureSnapshots,
        generated_by: user.id,
        generated_at: generatedAt.toISOString(),
      }, { onConflict: "approval_id" });
      if (evidenceError) throw evidenceError;
    }

    return pdfResponse(bytes, order.po_number, false);
  } catch (error) {
    return errorResponse(error, 400);
  }
}

