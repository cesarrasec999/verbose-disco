"use client";

import { Suspense } from "react";
import CiclicosShell from "@/features/conteos-ciclicos/CiclicosShell";

export default function ConteosCiclicosRegistrosPage() {
  return (
    <Suspense>
      <CiclicosShell forcedTab="validador" forcedValTab="registros" />
    </Suspense>
  );
}
