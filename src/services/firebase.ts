import { initializeApp } from "firebase/app";
import { get, getDatabase, onValue, ref, set } from "firebase/database";
import type { ConsumerRecord } from "../types";

const firebaseConfig = {
  apiKey: "hp-delivery-helper",
  authDomain: "madhuban-d405b.firebaseapp.com",
  databaseURL: "https://madhuban-d405b-default-rtdb.firebaseio.com",
  projectId: "madhuban-d405b",
  appId: "1:000000000000:web:hpdeliveryhelper",
};

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

const cleanConsumer = (consumer: ConsumerRecord): ConsumerRecord => ({
  ...consumer,
  deleted: Boolean(consumer.deleted),
  syncStatus: "synced",
});

export const uploadConsumerToFirebase = async (consumer: ConsumerRecord): Promise<void> => {
  await set(ref(database, `consumers/${consumer.consumerNumber}`), cleanConsumer(consumer));
};

export const fetchConsumersFromFirebase = async (): Promise<ConsumerRecord[]> => {
  const snapshot = await get(ref(database, "consumers"));
  if (!snapshot.exists()) return [];

  const raw = snapshot.val() as Record<string, ConsumerRecord>;
  return Object.values(raw).map((item) => cleanConsumer(item));
};

export const fetchMasterPassword = async (): Promise<string | null> => {
  const snapshot = await get(ref(database, "settings/masterPassword"));
  if (!snapshot.exists()) return null;
  const value = snapshot.val();
  return typeof value === "string" ? value : null;
};

export const updateMasterPassword = async (password: string): Promise<void> => {
  await set(ref(database, "settings/masterPassword"), password);
};

export const subscribeMasterPassword = (callback: (password: string) => void): (() => void) => {
  const passwordRef = ref(database, "settings/masterPassword");
  const unsubscribe = onValue(passwordRef, (snapshot) => {
    if (!snapshot.exists()) return;
    const value = snapshot.val();
    if (typeof value === "string" && value.trim()) callback(value);
  });

  return () => unsubscribe();
};