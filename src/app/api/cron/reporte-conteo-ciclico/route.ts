import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";
import { buildDailyCyclicReportHTML } from "@/lib/cyclicDailyReport";

// Corre 1 vez al dia (ver vercel.json, 13:00 UTC = 8:00 America/Lima) disparado
// por Vercel Cron. Envia el mismo informe que el boton "Generar correo" del
// dashboard de conteo ciclico, pero de forma automatica via SMTP (no requiere
// que alguien abra la app ni copie/pegue nada a mano).
export const maxDuration = 60;

const DEFAULT_TO = "martha.barrera@gpc.pe";
const DEFAULT_CC = [
  "rociodelacruz@gpc.pe",
  "felipe.cabellos@gpc.pe",
  "marisol.vargas@gpc.pe",
  "malu.ccahuantico@gpc.pe",
  "loraine.palacio@gpc.pe",
  "sarita.romero@gpc.pe",
].join(",");

function getYesterdayLimaISO(): string {
  const nowLima = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Lima" }));
  nowLima.setDate(nowLima.getDate() - 1);
  const y = nowLima.getFullYear();
  const m = String(nowLima.getMonth() + 1).padStart(2, "0");
  const d = String(nowLima.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${cronSecret}`) {
      return NextResponse.json({ error: "No autorizado" }, { status: 401 });
    }
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

  const url = new URL(request.url);
  const dateParam = url.searchParams.get("date");
  const date = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : getYesterdayLimaISO();

  try {
    const { html, subject, hasData } = await buildDailyCyclicReportHTML(supabase, date);

    const to = process.env.REPORTE_CICLICOS_TO || DEFAULT_TO;
    const cc = process.env.REPORTE_CICLICOS_CC || DEFAULT_CC;

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: gmailUser, pass: gmailPass },
    });

    await transporter.sendMail({
      from: `"Sistema de Conteo Cíclico" <${gmailUser}>`,
      to,
      cc,
      subject,
      html,
    });

    return NextResponse.json({ ok: true, date, hasData, to, cc });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
