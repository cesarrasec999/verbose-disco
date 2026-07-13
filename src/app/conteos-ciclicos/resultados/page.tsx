"use client";

import { Suspense } from "react";
import CiclicosShell from "@/features/conteos-ciclicos/CiclicosShell";

export default function ConteosCiclicosResultadosPage() {
  return (
    <Suspense>
      <CiclicosShell forcedTab="validador" forcedValTab="resultados" />
    </Suspense>
  );
}
