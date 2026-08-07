import { notFound } from "next/navigation";
import ReportesModule from "@/features/reportes/ReportesModule";

const tabs = new Set(["stock", "rotaciones", "ventas", "presupuesto"]);

export default async function AnalysisReportPage({ params }: { params: Promise<{ tab: string }> }) {
  const { tab } = await params;
  if (!tabs.has(tab)) notFound();
  return <ReportesModule basePath="/analisis/reportes" embedded activeTab={tab as "stock" | "rotaciones" | "ventas" | "presupuesto"} />;
}
