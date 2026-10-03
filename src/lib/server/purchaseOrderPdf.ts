import "server-only";

import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from "pdf-lib";

type PdfOrder = {
  po_number: string;
  business_status: string;
  store_no: string;
  store_code: string | null;
  store_name: string | null;
  vendor_code: string | null;
  vendor_name: string | null;
  buyer: string | null;
  po_date: string;
  ship_date: string | null;
  notes: string | null;
  qty_ordered: number;
  qty_received: number;
  total: number;
  currency_id: number | null;
};

type PdfLine = {
  line_id: number;
  product_code: string;
  description: string | null;
  unit: string | null;
  qty_ordered: number;
  cost: number;
  ext_cost: number;
};

type PdfRoute = null | {
  id: string;
  version: number;
  route_kind: string;
  approval_tier: string;
  currency_code: "PEN" | "USD";
  amount_snapshot: number;
  status: string;
  created_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  rejected_comment: string | null;
};

export type PdfApprovalStep = {
  id: string;
  step_order: number;
  role_key: string;
  approver_user_id: string | null;
  approver_name_snapshot: string;
  status: string;
  acted_at: string | null;
  comment: string | null;
  signature?: { bytes: Uint8Array; sha256: string } | null;
};

type BuildPurchaseOrderPdfInput = {
  order: PdfOrder;
  lines: PdfLine[];
  route: PdfRoute;
  steps: PdfApprovalStep[];
  allSignaturesReady?: boolean;
  generatedAt?: Date;
};

const A4: [number, number] = [595.28, 841.89];
const NAVY = rgb(0.035, 0.07, 0.16);
const ORANGE = rgb(0.95, 0.31, 0.04);
const SLATE = rgb(0.28, 0.34, 0.43);
const LIGHT = rgb(0.95, 0.97, 0.985);
const BORDER = rgb(0.8, 0.84, 0.89);
const GREEN = rgb(0.02, 0.5, 0.3);
const RED = rgb(0.82, 0.08, 0.12);

function safeText(value: unknown) {
  return String(value ?? "")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\u2192/g, ">")
    .replace(/\u00a0/g, " ")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "");
}

function num(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatNumber(value: unknown, digits = 2) {
  return new Intl.NumberFormat("es-PE", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(num(value));
}

function formatMoney(value: unknown, currency: "PEN" | "USD") {
  return `${currency === "USD" ? "US$" : "S/"} ${formatNumber(value, 2)}`;
}

function formatDate(value: string | Date | null | undefined, includeTime = false) {
  if (!value) return "-";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  }).format(date);
}

function statusLabel(status: string) {
  if (status === "approved") return "APROBADA";
  if (status === "rejected") return "RECHAZADA";
  if (status === "cancelled") return "CANCELADA";
  if (status === "superseded") return "REEMPLAZADA";
  return "PENDIENTE DE APROBACION";
}

function roleLabel(role: string) {
  if (role === "purchasing_lead") return "Lider de Compras";
  if (role === "purchasing_manager") return "Jefe de Compras";
  if (role === "finance_manager") return "Jefe de Finanzas";
  if (role === "treasury_lead") return "Lider de Tesoreria";
  return role;
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number, maxLines = 3) {
  const words = safeText(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (words.length && lines.length === maxLines) {
    const joined = lines.join(" ");
    if (joined.length < safeText(text).length) {
      let last = lines[lines.length - 1];
      while (last.length > 1 && font.widthOfTextAtSize(`${last}...`, size) > maxWidth) last = last.slice(0, -1);
      lines[lines.length - 1] = `${last}...`;
    }
  }
  return lines.length ? lines : ["-"];
}

function drawRight(page: PDFPage, text: string, right: number, y: number, font: PDFFont, size: number, color = NAVY) {
  const value = safeText(text);
  page.drawText(value, { x: right - font.widthOfTextAtSize(value, size), y, font, size, color });
}

export async function buildPurchaseOrderPdf(input: BuildPurchaseOrderPdfInput) {
  const { order, lines, route, steps } = input;
  const generatedAt = input.generatedAt || new Date();
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const currency = route?.currency_code || (Number(order.currency_id) === 2 ? "USD" : "PEN");
  const embeddedSignatures = new Map<string, PDFImage>();
  for (const step of steps) {
    if (step.signature?.bytes) {
      try { embeddedSignatures.set(step.id, await document.embedPng(step.signature.bytes)); } catch { /* El PDF indica si la firma no puede incrustarse. */ }
    }
  }

  let page: PDFPage;
  let y = 0;
  const margin = 32;
  const contentWidth = A4[0] - margin * 2;
  const addPage = () => {
    page = document.addPage(A4);
    y = A4[1] - 34;
    page.drawRectangle({ x: 0, y: A4[1] - 72, width: A4[0], height: 72, color: NAVY });
    page.drawRectangle({ x: 0, y: A4[1] - 76, width: A4[0], height: 4, color: ORANGE });
    page.drawRectangle({ x: margin, y: A4[1] - 61, width: 34, height: 34, color: ORANGE });
    page.drawText("R", { x: margin + 11, y: A4[1] - 51, size: 18, font: bold, color: rgb(1, 1, 1) });
    page.drawText("RASECORP", { x: margin + 44, y: A4[1] - 42, size: 15, font: bold, color: rgb(1, 1, 1) });
    page.drawText("ORDEN DE COMPRA", { x: margin + 44, y: A4[1] - 57, size: 8, font: bold, color: rgb(0.65, 0.72, 0.82) });
    drawRight(page, `OC ${order.po_number}`, A4[0] - margin, A4[1] - 46, bold, 15, rgb(1, 1, 1));
    y = A4[1] - 99;
    return page;
  };
  const ensure = (height: number) => { if (y - height < 54) addPage(); };

  addPage();
  const approvalStatus = route?.status || "unrouted";
  const isFinalDocument = approvalStatus === "approved" && input.allSignaturesReady === true;
  const visibleStatus = approvalStatus === "approved" && !isFinalDocument
    ? "APROBADA - FIRMAS NO CONFIGURADAS"
    : statusLabel(approvalStatus);
  const statusColor = isFinalDocument ? GREEN : approvalStatus === "rejected" ? RED : ORANGE;
  page!.drawRectangle({ x: margin, y: y - 25, width: contentWidth, height: 25, color: LIGHT, borderColor: BORDER, borderWidth: 0.7 });
  page!.drawText(visibleStatus, { x: margin + 10, y: y - 17, font: bold, size: 9, color: statusColor });
  drawRight(page!, `Vista generada: ${formatDate(generatedAt, true)}`, A4[0] - margin - 10, y - 17, regular, 8, SLATE);
  y -= 39;

  const info = [
    ["PROVEEDOR", order.vendor_name || "Sin proveedor", "CODIGO", order.vendor_code || "-"],
    ["TIENDA DE INGRESO", order.store_name || order.store_code || order.store_no, "SEDE RMS", order.store_no],
    ["FECHA OC", formatDate(order.po_date), "FECHA ENTREGA", formatDate(order.ship_date)],
    ["COMPRADOR", order.buyer || "-", "MONEDA", currency === "USD" ? "DOLARES" : "SOLES"],
  ];
  for (const row of info) {
    page!.drawRectangle({ x: margin, y: y - 24, width: contentWidth, height: 24, borderColor: BORDER, borderWidth: 0.55 });
    page!.drawText(row[0], { x: margin + 8, y: y - 15, font: bold, size: 6.5, color: SLATE });
    page!.drawText(safeText(row[1]).slice(0, 54), { x: margin + 94, y: y - 16, font: bold, size: 8, color: NAVY });
    page!.drawText(row[2], { x: margin + 344, y: y - 15, font: bold, size: 6.5, color: SLATE });
    page!.drawText(safeText(row[3]).slice(0, 24), { x: margin + 424, y: y - 16, font: bold, size: 8, color: NAVY });
    y -= 24;
  }
  if (order.notes) {
    const notes = wrapText(order.notes, regular, 7.5, contentWidth - 84, 2);
    const height = Math.max(24, notes.length * 10 + 8);
    page!.drawRectangle({ x: margin, y: y - height, width: contentWidth, height, borderColor: BORDER, borderWidth: 0.55 });
    page!.drawText("NOTAS", { x: margin + 8, y: y - 15, font: bold, size: 6.5, color: SLATE });
    notes.forEach((line, index) => page!.drawText(line, { x: margin + 94, y: y - 15 - index * 9, font: regular, size: 7.5, color: NAVY }));
    y -= height;
  }
  y -= 14;

  const columns = { item: margin, code: margin + 28, description: margin + 112, unit: margin + 332, qty: margin + 372, cost: margin + 424, total: margin + 480 };
  const drawTableHeader = () => {
    page!.drawRectangle({ x: margin, y: y - 22, width: contentWidth, height: 22, color: NAVY });
    [["#", columns.item + 7], ["CODIGO", columns.code], ["DESCRIPCION", columns.description], ["UM", columns.unit], ["CANT.", columns.qty], ["COSTO", columns.cost], ["TOTAL", columns.total]].forEach(([label, x]) => page!.drawText(String(label), { x: Number(x), y: y - 14, font: bold, size: 6.5, color: rgb(1, 1, 1) }));
    y -= 22;
  };
  drawTableHeader();
  lines.forEach((line, index) => {
    const description = wrapText(line.description || "-", regular, 7, 210, 2);
    const height = Math.max(24, description.length * 9 + 8);
    if (y - height < 78) { addPage(); drawTableHeader(); }
    if (index % 2 === 1) page!.drawRectangle({ x: margin, y: y - height, width: contentWidth, height, color: LIGHT });
    page!.drawRectangle({ x: margin, y: y - height, width: contentWidth, height, borderColor: BORDER, borderWidth: 0.35 });
    page!.drawText(String(index + 1), { x: columns.item + 8, y: y - 15, font: regular, size: 7, color: SLATE });
    page!.drawText(safeText(line.product_code).slice(0, 17), { x: columns.code, y: y - 15, font: bold, size: 7, color: NAVY });
    description.forEach((value, rowIndex) => page!.drawText(value, { x: columns.description, y: y - 15 - rowIndex * 9, font: regular, size: 7, color: NAVY }));
    page!.drawText(safeText(line.unit || "-").slice(0, 6), { x: columns.unit, y: y - 15, font: regular, size: 7, color: NAVY });
    drawRight(page!, formatNumber(line.qty_ordered, 2), columns.cost - 8, y - 15, regular, 7);
    drawRight(page!, formatNumber(line.cost, 2), columns.total - 8, y - 15, regular, 7);
    drawRight(page!, formatNumber(line.ext_cost, 2), A4[0] - margin - 7, y - 15, bold, 7);
    y -= height;
  });

  ensure(72);
  y -= 9;
  page!.drawRectangle({ x: A4[0] - margin - 210, y: y - 54, width: 210, height: 54, color: LIGHT, borderColor: BORDER, borderWidth: 0.7 });
  page!.drawText("TOTAL ORDEN", { x: A4[0] - margin - 198, y: y - 19, font: bold, size: 8, color: SLATE });
  drawRight(page!, formatMoney(order.total, currency), A4[0] - margin - 12, y - 40, bold, 16, NAVY);
  y -= 72;

  ensure(75 + Math.ceil(Math.max(steps.length, 1) / 2) * 104);
  page!.drawText("RUTA DE APROBACION", { x: margin, y, font: bold, size: 11, color: NAVY });
  y -= 18;
  if (!route) {
    page!.drawRectangle({ x: margin, y: y - 36, width: contentWidth, height: 36, color: LIGHT, borderColor: BORDER, borderWidth: 0.7 });
    page!.drawText("Esta OC pertenece al historial anterior a la activacion del flujo automatico.", { x: margin + 10, y: y - 22, font: regular, size: 8, color: SLATE });
    y -= 46;
  } else {
    const cardWidth = (contentWidth - 10) / 2;
    steps.forEach((step, index) => {
      const column = index % 2;
      if (column === 0 && index > 0) y -= 104;
      const x = margin + column * (cardWidth + 10);
      const cardY = y - 94;
      const approved = step.status === "approved";
      const rejected = step.status === "rejected";
      page!.drawRectangle({ x, y: cardY, width: cardWidth, height: 94, color: approved ? rgb(0.93, 0.98, 0.95) : rejected ? rgb(1, 0.94, 0.94) : LIGHT, borderColor: approved ? GREEN : rejected ? RED : BORDER, borderWidth: 0.8 });
      page!.drawText(`${step.step_order}. ${roleLabel(step.role_key)}`, { x: x + 9, y: cardY + 76, font: bold, size: 7, color: SLATE });
      page!.drawText(safeText(step.approver_name_snapshot).slice(0, 38), { x: x + 9, y: cardY + 61, font: bold, size: 9, color: NAVY });
      const state = approved ? `APROBADO ${formatDate(step.acted_at, true)}` : rejected ? `RECHAZADO ${formatDate(step.acted_at, true)}` : step.status === "pending" ? "PENDIENTE" : "EN ESPERA";
      page!.drawText(state, { x: x + 9, y: cardY + 47, font: bold, size: 6.5, color: approved ? GREEN : rejected ? RED : ORANGE });
      const signature = embeddedSignatures.get(step.id);
      if (approved && signature) {
        const scale = Math.min(100 / signature.width, 30 / signature.height);
        page!.drawImage(signature, { x: x + cardWidth - signature.width * scale - 10, y: cardY + 8, width: signature.width * scale, height: signature.height * scale });
      } else {
        page!.drawText(approved ? "Firma digital no configurada" : "Sin firma hasta su aprobacion", { x: x + 9, y: cardY + 18, font: regular, size: 6.5, color: SLATE });
      }
    });
    if (steps.length) y -= Math.ceil(steps.length / 2) * 104;
    if (route.rejected_comment) {
      ensure(48);
      page!.drawRectangle({ x: margin, y: y - 38, width: contentWidth, height: 38, color: rgb(1, 0.94, 0.94), borderColor: RED, borderWidth: 0.7 });
      page!.drawText("MOTIVO DEL RECHAZO", { x: margin + 8, y: y - 13, font: bold, size: 6.5, color: RED });
      page!.drawText(safeText(route.rejected_comment).slice(0, 105), { x: margin + 8, y: y - 27, font: regular, size: 7.5, color: NAVY });
      y -= 48;
    }
  }

  document.getPages().forEach((current, index, pages) => {
    current.drawLine({ start: { x: margin, y: 37 }, end: { x: A4[0] - margin, y: 37 }, thickness: 0.5, color: BORDER });
    current.drawText("Documento generado por RASECORP - Datos sincronizados desde RMS", { x: margin, y: 24, font: regular, size: 6.5, color: SLATE });
    drawRight(current, `Pagina ${index + 1} de ${pages.length}`, A4[0] - margin, 24, bold, 6.5, SLATE);
    if (!isFinalDocument) {
      current.drawText("VISTA PREVIA - NO HABILITA IMPRESION FINAL", { x: 155, y: 50, font: bold, size: 8, color: ORANGE, opacity: 0.75 });
    }
  });

  document.setTitle(`Orden de Compra ${order.po_number}`);
  document.setAuthor("RASECORP");
  document.setSubject("Orden de compra RMS y ruta de aprobacion");
  document.setCreationDate(generatedAt);
  return document.save({ useObjectStreams: false });
}

