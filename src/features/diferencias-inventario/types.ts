export type DifferenceStatus = "pendiente" | "regularizado" | "rechazado";
export type DifferenceReason =
  | "cruce_sku"
  | "ajuste_inventario"
  | "post_inventario"
  | "ingreso_provisional"
  | "regularizacion_provisional"
  | "transformacion_interna";

export type RequestProductDetail = {
  role: "principal" | "cruce" | "negativo" | "positivo";
  product_id: string;
  sku: string;
  description: string | null;
  unit: string | null;
  system_stock: number;
  quantity: number;
};

export type DifferenceRequestData = {
  products?: RequestProductDetail[];
  regularization_process?: "Compras" | "Abastecimiento";
  provisional_pending?: number | null;
  notes?: string | null;
  /** Identifica las dos líneas que pertenecen al mismo cruce de SKU. */
  cross_group_id?: string;
  cross_line_role?: "principal" | "cruce";
};

export type DifferenceReport = {
  id: string;
  store_id: string | null;
  store_name: string | null;
  product_id: string | null;
  reason: DifferenceReason;
  request_data: DifferenceRequestData;
  sku: string;
  description: string | null;
  unit: string | null;
  system_stock_at_report: number;
  physical_qty: number | null;
  photo_url: string | null;
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
