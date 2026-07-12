import { Suspense } from "react";
import RecepcionModule from "@/features/recepcion/RecepcionModule";

export default function RecepcionResumenPage() {
  return (
    <Suspense>
      <RecepcionModule listPanel="resumen" />
    </Suspense>
  );
}
