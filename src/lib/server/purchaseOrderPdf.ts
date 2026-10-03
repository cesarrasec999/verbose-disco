import "server-only";

import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from "pdf-lib";

type PdfOrder = {
  po_number: string;
  po_no: number | null;
  business_status: string;
  store_no: string;
  store_code: string | null;
  store_name: string | null;
  vendor_code: string | null;
  vendor_name: string | null;
  buyer: string | null;
  po_date: string;
  ship_date: string | null;
  cancel_date: string | null;
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
  logoBytes?: Uint8Array | null;
  allSignaturesReady?: boolean;
  generatedAt?: Date;
};

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const NAVY = rgb(0.025, 0.055, 0.22);
const RED = rgb(0.94, 0.02, 0.02);
const GREEN = rgb(0.0, 0.45, 0.22);
const GRAY = rgb(0.42, 0.45, 0.52);
const LIGHT = rgb(0.965, 0.97, 0.985);

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
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(num(value));
}

function formatDate(value: string | Date | null | undefined) {
  if (!value) return "-";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    day: "numeric",
    month: "numeric",
    year: "numeric",
  }).format(date);
}

function formatTime(value: Date) {
  return new Intl.DateTimeFormat("es-PE", {
    timeZone: "America/Lima",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(value);
}

function statusLabel(status: string) {
  if (status === "approved") return "APROBADO";
  if (status === "rejected") return "RECHAZADO";
  if (status === "cancelled") return "CANCELADO";
  if (status === "superseded") return "REEMPLAZADO";
  if (status === "unrouted") return "SIN RUTA";
  return "PENDIENTE";
}

function roleLabel(role: string) {
  if (role === "purchasing_lead") return "Lider de Compras";
  if (role === "purchasing_manager") return "Jefe de Compras";
  if (role === "finance_manager") return "Jefe de Finanzas";
  if (role === "treasury_lead") return "Lider de Tesoreria";
  return role;
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number, maxLines = 2) {
  const source = safeText(text).trim() || "-";
  const words = source.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
      if (lines.length >= maxLines) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.join(" ").length < source.length) {
    let last = lines[lines.length - 1] || "";
    while (last.length > 1 && font.widthOfTextAtSize(`${last}...`, size) > maxWidth) last = last.slice(0, -1);
    lines[lines.length - 1] = `${last}...`;
  }
  return lines;
}

function textTop(page: PDFPage, text: string, x: number, top: number, font: PDFFont, size: number, color = NAVY) {
  page.drawText(safeText(text), { x, y: PAGE_HEIGHT - top - size, font, size, color });
}

function rightTop(page: PDFPage, text: string, right: number, top: number, font: PDFFont, size: number, color = NAVY) {
  const value = safeText(text);
  textTop(page, value, right - font.widthOfTextAtSize(value, size), top, font, size, color);
}

function centeredTop(page: PDFPage, text: string, center: number, top: number, font: PDFFont, size: number, color = NAVY) {
  const value = safeText(text);
  textTop(page, value, center - font.widthOfTextAtSize(value, size) / 2, top, font, size, color);
}

function lineTop(page: PDFPage, top: number, x1 = 3, x2 = 592, thickness = 0.45, color = NAVY) {
  page.drawLine({ start: { x: x1, y: PAGE_HEIGHT - top }, end: { x: x2, y: PAGE_HEIGHT - top }, thickness, color });
}

function boxTop(page: PDFPage, x: number, top: number, width: number, height: number, color = LIGHT) {
  page.drawRectangle({ x, y: PAGE_HEIGHT - top - height, width, height, color, borderColor: NAVY, borderWidth: 0.45 });
}

function rmsOrderNumber(order: PdfOrder) {
  const po = order.po_no == null ? order.po_number : String(order.po_no);
  return `${order.store_no || "0"}-${po}`;
}

function vendorRuc(value: string | null) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length !== 10) return value || "-";
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = digits.split("").reduce((total, digit, index) => total + Number(digit) * weights[index], 0);
  let check = 11 - (sum % 11);
  if (check === 10) check = 0;
  if (check === 11) check = 1;
  return `${digits}${check}`;
}

export async function buildPurchaseOrderPdf(input: BuildPurchaseOrderPdfInput) {
  const { order, lines, route, steps } = input;
  const generatedAt = input.generatedAt || new Date();
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const currency = route?.currency_code || (Number(order.currency_id) === 2 ? "USD" : "PEN");
  const approvalStatus = route?.status || "unrouted";
  const isFinalDocument = approvalStatus === "approved" && input.allSignaturesReady === true;
  const orderLabel = rmsOrderNumber(order);
  const embeddedLogo = input.logoBytes ? await document.embedPng(input.logoBytes) : null;
  const embeddedSignatures = new Map<string, PDFImage>();
  for (const step of steps) {
    if (!step.signature?.bytes) continue;
    try { embeddedSignatures.set(step.id, await document.embedPng(step.signature.bytes)); } catch { /* Se muestra el estado aunque el PNG sea invalido. */ }
  }

  let page: PDFPage;
  let cursorTop = 0;
  const pages: PDFPage[] = [];

  const drawCompanyHeader = (current: PDFPage, compact = false) => {
    if (!compact && embeddedLogo) {
      current.drawImage(embeddedLogo, { x: 3, y: PAGE_HEIGHT - 80, width: 160, height: 77 });
    } else if (embeddedLogo) {
      current.drawImage(embeddedLogo, { x: 4, y: PAGE_HEIGHT - 52, width: 95, height: 43 });
    }
    if (compact) {
      centeredTop(current, "GLOBAL PERLA'S CAR S.A.C.", 280, 12, bold, 9.2);
      rightTop(current, `ORDEN DE COMPRA:${orderLabel}`, 590, 12, bold, 8.2);
      centeredTop(current, "RUC: 20546153372", 280, 27, bold, 7.5);
      return;
    }
    centeredTop(current, "GLOBAL PERLA'S CAR S.A.C.", 265, 13, bold, 10.5);
    centeredTop(current, "RUC: 20546153372", 265, 37, bold, 8.8);
    textTop(current, formatDate(generatedAt), 381, 4, bold, 7.2);
    textTop(current, formatTime(generatedAt), 480, 4, bold, 7.2);
    textTop(current, statusLabel(approvalStatus), 349, 43, bold, 14, RED);
    textTop(current, `ORDEN DE COMPRA:${orderLabel}`, 349, 65, bold, 9.4);
    textTop(current, "Fecha Orden:", 349, 82, bold, 7.3);
    textTop(current, formatDate(order.po_date), 401, 82, regular, 7.3);
    textTop(current, "Fecha Entrega:", 349, 99, bold, 7.3);
    textTop(current, formatDate(order.ship_date), 408, 99, regular, 7.3);
    textTop(current, "Fecha Cancelacion:", 349, 116, bold, 7.3);
    textTop(current, formatDate(order.cancel_date), 426, 116, regular, 7.3);

    textTop(current, "Proveedor:", 3, 84, bold, 6.8);
    textTop(current, order.vendor_name || "-", 41, 84, regular, 6.8);
    textTop(current, "Ruc:", 3, 99, bold, 6.8);
    textTop(current, vendorRuc(order.vendor_code), 20, 99, regular, 6.8);
    textTop(current, "Direccion:", 3, 115, bold, 6.8);
    textTop(current, "-", 42, 115, regular, 6.8);
    textTop(current, "Entregar en:", 3, 144, bold, 6.8);
    textTop(current, order.store_name || order.store_code || order.store_no, 65, 144, regular, 6.8);
    textTop(current, "-", 65, 159, regular, 6.8);
    textTop(current, "Autor:", 349, 147, bold, 7.1);
    textTop(current, order.buyer || "-", 372, 147, regular, 7.1);
    textTop(current, "Moneda:", 349, 163, bold, 7.1);
    textTop(current, currency === "USD" ? "DOLARES" : "SOLES", 382, 163, bold, 7.1);
  };

  const drawTableHeader = (current: PDFPage, top: number) => {
    lineTop(current, top, 3, 592, 0.55);
    textTop(current, "Nro", 5, top + 3, bold, 7.2);
    textTop(current, "Codigo", 31, top + 3, bold, 7.2);
    textTop(current, "Descripcion", 94, top + 3, bold, 7.2);
    centeredTop(current, "Cant.", 341, top + 1, bold, 7.2);
    centeredTop(current, "Unidades", 341, top + 10, bold, 7.2);
    centeredTop(current, "Caja/Rollo/", 391, top + 1, bold, 7.2);
    centeredTop(current, "Paquete", 391, top + 10, bold, 7.2);
    centeredTop(current, "Unidad", 449, top + 1, bold, 7.2);
    centeredTop(current, "Medida", 449, top + 10, bold, 7.2);
    centeredTop(current, "Costo", 505, top + 3, bold, 7.2);
    centeredTop(current, "Costo Total", 566, top + 3, bold, 7.2);
    lineTop(current, top + 23, 3, 592, 0.55);
    return top + 25;
  };

  const addPage = (first: boolean, withTableHeader = true) => {
    page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    pages.push(page);
    drawCompanyHeader(page, !first);
    cursorTop = first ? 173 : 56;
    if (withTableHeader) cursorTop = drawTableHeader(page, cursorTop);
    return page;
  };

  addPage(true);
  lines.forEach((line, index) => {
    const descriptionLines = wrapText(line.description || "-", regular, 5.9, 224, 2);
    const rowHeight = descriptionLines.length > 1 ? 17 : 12.5;
    if (cursorTop + rowHeight > 800) addPage(false);
    textTop(page!, String(index + 1), 5, cursorTop + 2, regular, 6.2);
    textTop(page!, line.product_code, 31, cursorTop + 2, regular, 6.2);
    descriptionLines.forEach((value, lineIndex) => textTop(page!, value, 94, cursorTop + 2 + lineIndex * 7, regular, 5.9));
    rightTop(page!, formatNumber(line.qty_ordered), 360, cursorTop + 2, regular, 6.2);
    centeredTop(page!, "0", 391, cursorTop + 2, regular, 6.2);
    centeredTop(page!, line.unit || "-", 449, cursorTop + 2, regular, 6.2);
    rightTop(page!, formatNumber(line.cost), 524, cursorTop + 2, regular, 6.2);
    rightTop(page!, formatNumber(line.ext_cost), 592, cursorTop + 2, regular, 6.2);
    cursorTop += rowHeight;
  });
  lineTop(page!, cursorTop + 1, 3, 592, 0.55);
  cursorTop += 9;

  const approvalHeight = steps.length ? 98 : 48;
  const summaryHeight = 88 + (order.notes ? 24 : 0) + approvalHeight;
  if (cursorTop + summaryHeight > 810) addPage(false, false);

  const subtotal = num(order.total) / 1.18;
  const tax = num(order.total) - subtotal;
  textTop(page!, "Condicion de Pago:", 3, cursorTop + 1, bold, 7.1);
  textTop(page!, "-", 94, cursorTop + 1, bold, 7.1);
  textTop(page!, "Cuenta:", 3, cursorTop + 18, bold, 7.1);
  textTop(page!, "-", 94, cursorTop + 18, regular, 7.1);
  textTop(page!, "Subtotal:", 411, cursorTop + 1, bold, 7.8);
  rightTop(page!, formatNumber(subtotal), 592, cursorTop + 1, bold, 7.8);
  textTop(page!, "Impuesto:", 411, cursorTop + 18, bold, 7.8);
  rightTop(page!, formatNumber(tax), 592, cursorTop + 18, bold, 7.8);
  lineTop(page!, cursorTop + 32, 419, 592, 0.4);
  textTop(page!, "Total:", 411, cursorTop + 37, bold, 7.8);
  rightTop(page!, formatNumber(order.total), 592, cursorTop + 37, bold, 7.8);
  lineTop(page!, cursorTop + 54, 411, 592, 0.55);
  cursorTop += 66;

  if (order.notes) {
    const notes = wrapText(order.notes, regular, 7.0, 580, 2);
    notes.forEach((value, index) => textTop(page!, value, 3, cursorTop + index * 9, regular, 7.0));
    cursorTop += notes.length * 9 + 10;
  }

  if (cursorTop + approvalHeight > 808) addPage(false, false);
  textTop(page!, "RUTA DE APROBACION", 3, cursorTop, bold, 8.2);
  if (route) rightTop(page!, `Version ${route.version}`, 592, cursorTop, regular, 6.2, GRAY);
  cursorTop += 15;

  if (!route || !steps.length) {
    boxTop(page!, 3, cursorTop, 589, 30, rgb(1, 1, 1));
    textTop(page!, "Esta orden pertenece al historial anterior a la activacion del flujo automatico.", 10, cursorTop + 9, regular, 6.8, GRAY);
  } else {
    const gap = 5;
    const cardWidth = (589 - gap * (steps.length - 1)) / steps.length;
    steps.forEach((step, index) => {
      const x = 3 + index * (cardWidth + gap);
      boxTop(page!, x, cursorTop, cardWidth, 73, rgb(1, 1, 1));
      textTop(page!, roleLabel(step.role_key), x + 5, cursorTop + 5, bold, 5.8, GRAY);
      const names = wrapText(step.approver_name_snapshot, bold, 6.6, cardWidth - 10, 2);
      names.forEach((value, row) => textTop(page!, value, x + 5, cursorTop + 16 + row * 7, bold, 6.6));
      const approved = step.status === "approved";
      const rejected = step.status === "rejected";
      const state = approved ? "APROBADO" : rejected ? "RECHAZADO" : step.status === "pending" ? "PENDIENTE" : "EN ESPERA";
      textTop(page!, state, x + 5, cursorTop + 34, bold, 5.8, approved ? GREEN : rejected ? RED : GRAY);
      const signature = embeddedSignatures.get(step.id);
      if (approved && signature) {
        const scale = Math.min((cardWidth - 16) / signature.width, 23 / signature.height);
        page!.drawImage(signature, {
          x: x + (cardWidth - signature.width * scale) / 2,
          y: PAGE_HEIGHT - cursorTop - 67,
          width: signature.width * scale,
          height: signature.height * scale,
        });
      } else {
        lineTop(page!, cursorTop + 59, x + 8, x + cardWidth - 8, 0.35, GRAY);
        centeredTop(page!, approved ? "Firma no configurada" : "Firma", x + cardWidth / 2, cursorTop + 61, regular, 4.8, GRAY);
      }
    });
    if (route.rejected_comment) {
      textTop(page!, `Motivo: ${route.rejected_comment}`, 3, cursorTop + 78, regular, 6.2, RED);
    }
  }

  pages.forEach((current, index) => {
    if (!isFinalDocument) centeredTop(current, "VISTA PREVIA - NO HABILITA IMPRESION FINAL", PAGE_WIDTH / 2, 814, bold, 5.8, RED);
    rightTop(current, `Pagina ${index + 1} de ${pages.length}`, 592, 829, bold, 7.1);
  });

  document.setTitle(`Orden de Compra ${orderLabel}`);
  document.setAuthor("GLOBAL PERLA'S CAR S.A.C.");
  document.setSubject("Orden de compra RMS y ruta de aprobacion");
  document.setCreationDate(generatedAt);
  return document.save({ useObjectStreams: false });
}
