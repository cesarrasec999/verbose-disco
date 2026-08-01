export type DifferenceStatus = "pendiente" | "regularizado" | "rechazado";

export type DifferenceReport = {
  id: string;
  store_id: string | null;
  store_name: string | null;
  product_id: string | null;
  sku: string;
  description: string | null;
  unit: string | null;
  system_stock_at_report: number;
  physical_qty: number;
  photo_url: string;
  notes: string | null;
  operator_id: string | null;
  operator_name: string | null;
  status: DifferenceStatus;
  adjustment_number: string | null;
  validated_by: string | null;
  validated_by_name: string | null;
  validated_at: string | null;
  created_at: string;
};
