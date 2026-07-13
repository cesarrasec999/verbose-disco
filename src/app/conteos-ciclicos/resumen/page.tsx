"use client";

import { Suspense } from "react";
import CiclicosShell from "@/features/conteos-ciclicos/CiclicosShell";

export default function ConteosCiclicosResumenPage() {
  return (
    <Suspense>
      <CiclicosShell forcedTab="validador" forcedValTab="resumen" />
    </Suspense>
  );
}
