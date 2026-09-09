import PickingModule from "@/features/picking/PickingModule";
import PickingRecords from "@/features/picking/PickingRecords";

export default async function PickingRegistrosPage({ searchParams }: { searchParams: Promise<{ legacy?: string }> }) {
  const query = await searchParams;
  return query.legacy === "1" ? <PickingModule panel="registros" /> : <PickingRecords />;
}
