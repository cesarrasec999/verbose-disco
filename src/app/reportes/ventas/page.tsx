import { Suspense } from "react";
import ReportesModule from "@/features/reportes/ReportesModule";

export default function ReportesVentasPage() {
  return (
    <Suspense>
      <ReportesModule activeTab="ventas" />
    </Suspense>
  );
}
