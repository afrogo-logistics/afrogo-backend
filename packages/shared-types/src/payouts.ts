export interface DriverPayoutRow {
  id: string;
  driver_id: string;
  route_id: string;
  parcels_delivered: number | string;
  planned_distance_km: number | string;
  actual_distance_km: number | string;
  variance_pct: number | string;
  total_payout: number | string;
  payout_status: string;
  created_at: string | Date;
}
