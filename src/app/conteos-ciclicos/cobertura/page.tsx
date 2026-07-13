"use client";

import { Suspense } from "react";
import CiclicosShell from "@/features/conteos-ciclicos/CiclicosShell";

export default function ConteosCiclicosCoberturaPage() {
  return (
    <Suspense>
      <CiclicosShell forcedTab="validador" forcedValTab="cobertura" />
    </Suspense>
  );
}
