import type { ProductionQueueItem } from "@shared/schema";
import type { WorkshopStationId } from "@/lib/workshop-stations";
import type { WorkshopIntegrationTag } from "@/lib/workshop-integrations";

export type WorkshopHover = {
  dealId: string;
  name: string;
  shipBy: string;
  station: WorkshopStationId;
};

export type WorkshopCanvasProps = {
  orders: ProductionQueueItem[];
  tags: WorkshopIntegrationTag[];
  selectedDealId: string | null;
  printing: boolean;
  dark: boolean;
  reduceMotion: boolean;
  onHover: (hover: WorkshopHover | null) => void;
  onSelect: (dealId: string) => void;
};
