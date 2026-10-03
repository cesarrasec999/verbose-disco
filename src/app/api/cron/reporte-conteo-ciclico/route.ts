import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";
import { buildDailyCyclicReportHTML, buildDailyDetailXlsxBuffer, type DailyCyclicCountType } from "@/lib/cyclicDailyReport";
import {
  CYCLIC_REPORT_DEFAULT_CC,
  CYCLIC_REPORT_DEFAULT_TO,
  cyclicReportCcRecipients,
} from "@/lib/cyclicReportRecipients";

// Corre 1 vez al dia (ver vercel.json, 13:00 UTC = 8:00 America/Lima) disparado
// por Vercel Cron. Envia el mismo informe que el boton "Generar correo" del
// dashboard de conteo ciclico, pero de forma automatica via SMTP (no requiere
// que alguien abra la app ni copie/pegue nada a mano).
export const maxDuration = 60;

function getYesterdayLimaISO(): string {
  const nowLima = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Lima" }));
  nowLima.setDate(nowLima.getDate() - 1);
  const y = nowLima.getFullYear();
  const m = String(nowLima.getMonth() + 1).padStart(2, "0");
  const d = String(nowLima.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const DEPLOY_COMMIT = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || null;

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "No autorizado" }, { status: 401 });
    }
  }

  const url = new URL(request.url);
  if (url.searchParams.get("probe") === "1") {
    // No toca Supabase ni envia correo: solo confirma que deploy esta activo, para
    // no disparar pruebas reales contra un deploy anterior mientras Vercel propaga.
    return NextResponse.json({ ok: true, probe: true, commit: DEPLOY_COMMIT });
  }

  const gmailUser = process.env.GMAIL_USER;
  const gmailPass = process.env.GMAIL_APP_PASSWORD;
  if (!gmailUser || !gmailPass) {
    return NextResponse.json({ error: "Falta configurar GMAIL_USER / GMAIL_APP_PASSWORD en el servidor." }, { status: 500 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({ error: "Falta configurar NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY." }, { status: 500 });
  }
  const supabase = createClient(supabaseUrl, supabaseKey);

  const dateParam = url.searchParams.get("date");
  const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : getYesterdayLimaISO();
  // Override de destinatario solo para pruebas manuales (mismo CRON_SECRET que ya protege
  // el endpoint). Sin este parametro, el envio real usa siempre TO/CC de produccion.
  const toOverride = url.searchParams.get("to");

  try {
    const { data: savedRecipients } = await supabase
      .from("cyclic_report_email_settings")
      .select("to_recipients,cc_recipients")
      .eq("id", "daily")
      .maybeSingle();
    const savedTo = Array.isArray(savedRecipients?.to_recipients)
      ? savedRecipients.to_recipients.filter(Boolean).join(",")
      : "";
    const savedCc = Array.isArray(savedRecipients?.cc_recipients)
      ? savedRecipients.cc_recipients.filter(Boolean).join(",")
      : "";
    const to = toOverride || savedTo || process.env.REPORTE_CICLICOS_TO || CYCLIC_REPORT_DEFAULT_TO;
    // Yolanda debe permanecer en copia incluso si Vercel tiene una lista CC
    // personalizada mediante variable de entorno.
    const cc = toOverride
      ? undefined
      : cyclicReportCcRecipients(savedCc || process.env.REPORTE_CICLICOS_CC || CYCLIC_REPORT_DEFAULT_CC);

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: gmailUser, pass: gmailPass },
    });

    const results: Array<{ type: DailyCyclicCountType; sent: boolean; attached: boolean }> = [];
    for (const type of ["cyclic", "leader", "supervisor"] as DailyCyclicCountType[]) {
      const { html, subject, hasData } = await buildDailyCyclicReportHTML(supabase, date, type);
      // Cada tipo se envía por separado; si ese día no tiene asignaciones no genera correo.
      if (!hasData) {
        results.push({ type, sent: false, attached: false });
        continue;
      }
      const xlsxBuffer = await buildDailyDetailXlsxBuffer(supabase, date, type);
      await transporter.sendMail({
        from: `"Sistema de Conteo Cíclico" <${gmailUser}>`,
        to,
        cc,
        subject,
        html,
        attachments: xlsxBuffer
          ? [{
              filename: `conteo_${type}_detalle_${date}.xlsx`,
              content: xlsxBuffer,
              contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            }]
          : undefined,
      });
      results.push({ type, sent: true, attached: !!xlsxBuffer });
    }

    return NextResponse.json({ ok: true, date, to, cc, results, commit: DEPLOY_COMMIT });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
