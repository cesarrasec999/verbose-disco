import { Suspense } from "react";
import ReportesModule from "@/features/reportes/ReportesModule";

export default function ReportesPresupuestoPage() {
  return (
    <Suspense>
      <ReportesModule activeTab="presupuesto" />
    </Suspense>
  );
}
