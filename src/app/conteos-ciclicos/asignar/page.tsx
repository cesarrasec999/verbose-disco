"use client";

import { Suspense } from "react";
import CiclicosShell from "@/features/conteos-ciclicos/CiclicosShell";

export default function ConteosCiclicosAsignarPage() {
  return (
    <Suspense>
      <CiclicosShell forcedTab="validador" forcedValTab="asignar" />
    </Suspense>
  );
}
