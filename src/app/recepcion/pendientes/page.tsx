import { Suspense } from "react";
import RecepcionModule from "@/features/recepcion/RecepcionModule";

export default function RecepcionPendientesPage() {
  return (
    <Suspense>
      <RecepcionModule listPanel="pendientes" />
    </Suspense>
  );
}
