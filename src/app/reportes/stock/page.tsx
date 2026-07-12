import { Suspense } from "react";
import ReportesModule from "@/features/reportes/ReportesModule";

export default function ReportesStockPage() {
  return (
    <Suspense>
      <ReportesModule activeTab="stock" />
    </Suspense>
  );
}
