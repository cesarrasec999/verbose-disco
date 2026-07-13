"use client";

import { Suspense } from "react";
import CiclicosShell from "@/features/conteos-ciclicos/CiclicosShell";

export default function ConteosCiclicosProgresoPage() {
  return (
    <Suspense>
      <CiclicosShell forcedTab="validador" forcedValTab="progreso" />
    </Suspense>
  );
}
