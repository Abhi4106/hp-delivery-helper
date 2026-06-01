export type SyncStatus = "synced" | "pending";

export type ConsumerRecord = {
  consumerNumber: string;
  consumerName: string;
  mobileNumber: string;
  landmark: string;
  imagePath: string;
  latitude: number;
  longitude: number;
  locationTimestamp: string;
  createdDate: string;
  updatedDate: string;
  deleted: boolean;
  syncStatus: SyncStatus;
};

export type ConsumerFormState = {
  consumerNumber: string;
  consumerName: string;
  mobileNumber: string;
  landmark: string;
  imagePath: string;
  latitude: string;
  longitude: string;
  locationTimestamp: string;
  masterPassword: string;
};

export const DEFAULT_MASTER_PASSWORD = "809988";