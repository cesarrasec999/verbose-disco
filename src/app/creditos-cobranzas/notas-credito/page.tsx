import { Suspense } from "react";
import CreditosCobranzasModule from "@/features/creditos-cobranzas/CreditosCobranzasModule";

export default function NotasCreditoPage() {
  return (
    <Suspense>
      <CreditosCobranzasModule subTab="notas_credito" />
    </Suspense>
  );
}
