import { Suspense } from "react";
import ReportesModule from "@/features/reportes/ReportesModule";

export default function ReportesRotacionesPage() {
  return (
    <Suspense>
      <ReportesModule activeTab="rotaciones" />
    </Suspense>
  );
}
