import { Suspense } from "react";
import RecepcionModule from "@/features/recepcion/RecepcionModule";

export default function RecepcionDiferenciasPage() {
  return (
    <Suspense>
      <RecepcionModule listPanel="diferencias" />
    </Suspense>
  );
}
