import { useEffect, useMemo, useRef, useState } from "react";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { Geolocation } from "@capacitor/geolocation";
import { Network } from "@capacitor/network";
import { AnimatePresence, motion } from "framer-motion";
import { fetchConsumersFromFirebase, fetchMasterPassword, subscribeMasterPassword, updateMasterPassword, uploadConsumerToFirebase } from "./services/firebase";
import { localDb } from "./services/localDb";
import { requestInitialPermissions } from "./services/permissions";
import { DEFAULT_MASTER_PASSWORD, type ConsumerFormState, type ConsumerRecord } from "./types";

type Screen = "home" | "add" | "list" | "edit" | "admin";

const emptyForm: ConsumerFormState = {
  consumerNumber: "",
  consumerName: "",
  mobileNumber: "",
  landmark: "",
  imagePath: "",
  latitude: "",
  longitude: "",
  locationTimestamp: "",
  masterPassword: "",
};

const isValidConsumerNumber = (value: string): boolean => /^\d{6}$/.test(value);
const isValidMobileNumber = (value: string): boolean => /^\d{10}$/.test(value);

const parseDate = (value: string): number => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const formatDateTime = (value: string): string => {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return "-";
  return new Date(parsed).toLocaleString();
};

export default function App() {
  const [screen, setScreen] = useState<Screen>("home");
  const [consumers, setConsumers] = useState<ConsumerRecord[]>([]);
  const [homeSearch, setHomeSearch] = useState("");
  const [homeResults, setHomeResults] = useState<ConsumerRecord[]>([]);
  const [hasSearchedHome, setHasSearchedHome] = useState(false);
  const [listSearch, setListSearch] = useState("");
  const [formState, setFormState] = useState<ConsumerFormState>(emptyForm);
  const [editingNumber, setEditingNumber] = useState<string | null>(null);
  const [masterPassword, setMasterPassword] = useState(DEFAULT_MASTER_PASSWORD);
  const [isOnline, setIsOnline] = useState<boolean>(navigator.onLine);
  const [lastSyncTime, setLastSyncTime] = useState<string>("Never");
  const [pendingCount, setPendingCount] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [isSyncing, setIsSyncing] = useState(false);
  const [adminNewPassword, setAdminNewPassword] = useState("");
  const [adminConfirmPassword, setAdminConfirmPassword] = useState("");
  const [viewerImagePath, setViewerImagePath] = useState<string | null>(null);
  const [viewerZoom, setViewerZoom] = useState(1);
  const syncLock = useRef(false);
  const holdTimer = useRef<number | null>(null);

  const activeConsumers = useMemo(
    () => consumers.filter((item) => !item.deleted).sort((a, b) => parseDate(b.updatedDate) - parseDate(a.updatedDate)),
    [consumers],
  );

  const listResults = useMemo(() => {
    const query = listSearch.trim().toLowerCase();
    if (!query) return activeConsumers;
    return activeConsumers.filter((item) => {
      const stack = `${item.consumerNumber} ${item.consumerName} ${item.mobileNumber} ${item.landmark}`.toLowerCase();
      return stack.includes(query);
    });
  }, [activeConsumers, listSearch]);

  const refreshConsumerState = async (): Promise<void> => {
    const allConsumers = await localDb.getAllConsumers(true);
    setConsumers(allConsumers);
  };

  const refreshSyncState = async (): Promise<void> => {
    const pending = await localDb.getPendingCount();
    setPendingCount(pending);
    const lastSync = await localDb.getMeta("lastSyncTime");
    setLastSyncTime(lastSync ? formatDateTime(lastSync) : "Never");
  };

  const runSync = async (): Promise<void> => {
    if (!isOnline || syncLock.current) return;

    syncLock.current = true;
    setIsSyncing(true);

    try {
      const pending = await localDb.getPendingConsumers();
      for (const consumer of pending) {
        await uploadConsumerToFirebase(consumer);
        await localDb.markSynced(consumer.consumerNumber);
      }

      const remote = await fetchConsumersFromFirebase();
      const local = await localDb.getAllConsumers(true);
      const localMap = new Map(local.map((item) => [item.consumerNumber, item]));

      for (const remoteConsumer of remote) {
        const localConsumer = localMap.get(remoteConsumer.consumerNumber);
        if (!localConsumer) {
          await localDb.upsertConsumer({ ...remoteConsumer, syncStatus: "synced" });
          continue;
        }

        const remoteIsNewer = parseDate(remoteConsumer.updatedDate) > parseDate(localConsumer.updatedDate);
        if (remoteIsNewer && localConsumer.syncStatus === "synced") {
          await localDb.upsertConsumer({ ...remoteConsumer, syncStatus: "synced" });
        }
      }

      const now = new Date().toISOString();
      await localDb.setMeta("lastSyncTime", now);
      setLastSyncTime(formatDateTime(now));
      await refreshConsumerState();
      await refreshSyncState();
      setStatusMessage("Sync complete.");
    } catch (error) {
      console.error("Sync failed", error);
      setStatusMessage("Sync failed. Changes remain pending and will retry automatically.");
    } finally {
      syncLock.current = false;
      setIsSyncing(false);
    }
  };

  useEffect(() => {
    let isMounted = true;
    let removeMasterSubscription: (() => void) | null = null;

    const initializeApp = async (): Promise<void> => {
      await localDb.init();
      await requestInitialPermissions();

      const cachedPassword = await localDb.getMeta("masterPassword");
      if (cachedPassword) setMasterPassword(cachedPassword);

      try {
        const remotePassword = await fetchMasterPassword();
        if (!remotePassword) {
          await updateMasterPassword(DEFAULT_MASTER_PASSWORD);
          await localDb.setMeta("masterPassword", DEFAULT_MASTER_PASSWORD);
          if (isMounted) setMasterPassword(DEFAULT_MASTER_PASSWORD);
        } else {
          await localDb.setMeta("masterPassword", remotePassword);
          if (isMounted) setMasterPassword(remotePassword);
        }
      } catch (error) {
        console.error("Could not fetch master password from Firebase", error);
      }

      removeMasterSubscription = subscribeMasterPassword((newPassword) => {
        void localDb.setMeta("masterPassword", newPassword);
        if (isMounted) setMasterPassword(newPassword);
      });

      await refreshConsumerState();
      await refreshSyncState();

      try {
        const status = await Network.getStatus();
        if (isMounted) setIsOnline(status.connected);
      } catch {
        if (isMounted) setIsOnline(navigator.onLine);
      }
    };

    void initializeApp();

    const onlineListener = () => setIsOnline(true);
    const offlineListener = () => setIsOnline(false);
    window.addEventListener("online", onlineListener);
    window.addEventListener("offline", offlineListener);

    const networkListenerPromise = Network.addListener("networkStatusChange", (status) => {
      setIsOnline(status.connected);
    });

    return () => {
      isMounted = false;
      window.removeEventListener("online", onlineListener);
      window.removeEventListener("offline", offlineListener);
      networkListenerPromise
        .then((listener) => listener.remove())
        .catch(() => undefined);
      if (removeMasterSubscription) removeMasterSubscription();
    };
  }, []);

  useEffect(() => {
    if (isOnline) {
      void runSync();
    }
  }, [isOnline]);

  const updateForm = (field: keyof ConsumerFormState, value: string): void => {
    setFormState((prev) => ({ ...prev, [field]: value }));
  };

  const handleCaptureLocation = async (): Promise<void> => {
    try {
      const position = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
      updateForm("latitude", position.coords.latitude.toString());
      updateForm("longitude", position.coords.longitude.toString());
      updateForm("locationTimestamp", new Date(position.timestamp).toISOString());
      setStatusMessage("Location captured.");
    } catch (error) {
      console.error("Location capture failed", error);
      setStatusMessage("Unable to capture location. Please enable precise location permission.");
    }
  };

  const handlePickImage = async (source: CameraSource): Promise<void> => {
    try {
      const photo = await Camera.getPhoto({
        source,
        quality: 75,
        resultType: CameraResultType.Uri,
      });
      const imagePath = photo.path ?? photo.webPath ?? "";
      if (!imagePath) {
        setStatusMessage("Image capture failed.");
        return;
      }
      updateForm("imagePath", imagePath);
      setStatusMessage("Image selected.");
    } catch (error) {
      console.error("Image selection failed", error);
      setStatusMessage("Unable to access camera/gallery.");
    }
  };

  const validateConsumerForm = async (isEdit: boolean): Promise<string | null> => {
    if (!isValidConsumerNumber(formState.consumerNumber)) return "Consumer Number must be exactly 6 digits.";
    if (!formState.consumerName.trim()) return "Consumer Name is required.";
    if (!isValidMobileNumber(formState.mobileNumber)) return "Mobile Number must be exactly 10 digits.";
    if (!formState.landmark.trim()) return "Landmark is required.";
    if (!formState.imagePath.trim()) return "Consumer image is required.";
    if (!formState.latitude || !formState.longitude || !formState.locationTimestamp) return "Capture current location before saving.";
    if (formState.masterPassword !== masterPassword) return "Invalid Master Password.";

    const existing = await localDb.getConsumerByNumber(formState.consumerNumber);
    if (!isEdit && existing && !existing.deleted) return "Duplicate Consumer Number. This number already exists.";

    return null;
  };

  const saveConsumer = async (): Promise<void> => {
    const isEdit = screen === "edit";
    const validationError = await validateConsumerForm(isEdit);
    if (validationError) {
      setStatusMessage(validationError);
      return;
    }

    const now = new Date().toISOString();
    const existing = await localDb.getConsumerByNumber(formState.consumerNumber);

    const payload: ConsumerRecord = {
      consumerNumber: formState.consumerNumber,
      consumerName: formState.consumerName.trim(),
      mobileNumber: formState.mobileNumber,
      landmark: formState.landmark.trim(),
      imagePath: formState.imagePath,
      latitude: Number(formState.latitude),
      longitude: Number(formState.longitude),
      locationTimestamp: formState.locationTimestamp,
      createdDate: existing?.createdDate ?? now,
      updatedDate: now,
      deleted: false,
      syncStatus: "pending",
    };

    await localDb.upsertConsumer(payload);
    await refreshConsumerState();
    await refreshSyncState();
    if (isOnline) await runSync();

    setFormState(emptyForm);
    setEditingNumber(null);
    setScreen("home");
    setStatusMessage("Consumer saved successfully.");
  };

  const searchHome = async (): Promise<void> => {
    if (!homeSearch.trim()) {
      setHasSearchedHome(false);
      setHomeResults([]);
      setStatusMessage("Enter search text to find a consumer.");
      return;
    }

    const results = await localDb.searchConsumers(homeSearch);
    setHomeResults(results);
    setHasSearchedHome(true);
    setStatusMessage(results.length ? `Found ${results.length} record(s).` : "No consumer found.");
  };

  const clearHomeSearch = (): void => {
    setHomeSearch("");
    setHomeResults([]);
    setHasSearchedHome(false);
    setStatusMessage("");
  };

  const openImageViewer = (imagePath: string): void => {
    setViewerZoom(1);
    setViewerImagePath(imagePath);
  };

  const updateZoom = (nextValue: number): void => {
    setViewerZoom(Math.max(1, Math.min(4, nextValue)));
  };

  const openSavedLocation = (item: ConsumerRecord): void => {
    const mapUrl = `https://www.google.com/maps/dir/?api=1&destination=${item.latitude},${item.longitude}`;
    window.open(mapUrl, "_blank", "noopener,noreferrer");
  };

  const openEditConsumer = (consumer: ConsumerRecord): void => {
    const input = window.prompt("Enter Master Password to Edit");
    if (input !== masterPassword) {
      setStatusMessage("Incorrect Master Password. Edit cancelled.");
      return;
    }

    setEditingNumber(consumer.consumerNumber);
    setFormState({
      consumerNumber: consumer.consumerNumber,
      consumerName: consumer.consumerName,
      mobileNumber: consumer.mobileNumber,
      landmark: consumer.landmark,
      imagePath: consumer.imagePath,
      latitude: String(consumer.latitude),
      longitude: String(consumer.longitude),
      locationTimestamp: consumer.locationTimestamp,
      masterPassword: "",
    });
    setScreen("edit");
  };

  const deleteConsumer = async (consumer: ConsumerRecord): Promise<void> => {
    const input = window.prompt("Enter Master Password to Delete");
    if (input !== masterPassword) {
      setStatusMessage("Incorrect Master Password. Delete cancelled.");
      return;
    }

    const confirmed = window.confirm(`Delete consumer ${consumer.consumerNumber}?`);
    if (!confirmed) return;

    await localDb.upsertConsumer({
      ...consumer,
      deleted: true,
      updatedDate: new Date().toISOString(),
      syncStatus: "pending",
    });

    await refreshConsumerState();
    await refreshSyncState();
    if (isOnline) await runSync();
    setStatusMessage("Consumer deleted.");
  };

  const openAdminFromLongPress = (): void => {
    const input = window.prompt("Enter Admin Password");
    if (input !== "Admin7086973588") {
      setStatusMessage("Invalid Admin Password.");
      return;
    }
    setAdminNewPassword("");
    setAdminConfirmPassword("");
    setScreen("admin");
  };

  const startAddButtonPress = (): void => {
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      openAdminFromLongPress();
    }, 10000);
  };

  const endAddButtonPress = (): void => {
    if (holdTimer.current) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
      setFormState(emptyForm);
      setEditingNumber(null);
      setScreen("add");
      setStatusMessage("Add Consumer screen opened.");
    }
  };

  const saveMasterPassword = async (): Promise<void> => {
    if (!adminNewPassword.trim()) {
      setStatusMessage("New Master Password is required.");
      return;
    }
    if (adminNewPassword !== adminConfirmPassword) {
      setStatusMessage("Passwords do not match.");
      return;
    }

    try {
      await updateMasterPassword(adminNewPassword);
      await localDb.setMeta("masterPassword", adminNewPassword);
      setMasterPassword(adminNewPassword);
      setAdminNewPassword("");
      setAdminConfirmPassword("");
      setStatusMessage("Master Password updated globally.");
      setScreen("home");
    } catch (error) {
      console.error("Master password update failed", error);
      setStatusMessage("Failed to update master password in Firebase.");
    }
  };

  const resetAndGoHome = (): void => {
    setFormState(emptyForm);
    setEditingNumber(null);
    setScreen("home");
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="sticky top-0 z-20 border-b border-slate-800 bg-slate-950/90 px-4 py-3 backdrop-blur">
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} className="mx-auto flex w-full max-w-5xl items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">HP DELIVERY HELPER</p>
            <h1 className="text-lg font-semibold">LPG Consumer Management</h1>
          </div>
          <button
            type="button"
            onClick={() => void runSync()}
            className="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-100 transition hover:border-slate-500"
          >
            {isSyncing ? "Syncing..." : "Sync Now"}
          </button>
        </motion.div>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-5 pb-32">
        <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="grid gap-2 rounded-lg border border-slate-800 bg-slate-900 p-4 text-sm">
          <p>
            <span className="text-slate-400">Status:</span> {isOnline ? "Online" : "Offline"}
          </p>
          <p>
            <span className="text-slate-400">Last Sync:</span> {lastSyncTime}
          </p>
          <p>
            <span className="text-slate-400">Pending Upload Count:</span> {pendingCount}
          </p>
        </motion.section>

        {statusMessage ? <p className="text-sm text-amber-300">{statusMessage}</p> : null}

        <AnimatePresence mode="wait">
          {screen === "home" && (
            <motion.section key="home" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="space-y-4">
              <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-4">
                <h2 className="text-base font-semibold">Search Consumer</h2>
                <div className="relative">
                  <input
                    value={homeSearch}
                    onChange={(event) => setHomeSearch(event.target.value)}
                    placeholder="Search by Number, Name, Mobile, Landmark"
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 pr-11 text-sm outline-none focus:border-cyan-400"
                  />
                  {homeSearch ? (
                    <button
                      type="button"
                      onClick={clearHomeSearch}
                      className="absolute top-1/2 right-2 -translate-y-1/2 rounded px-2 py-1 text-xs text-slate-300 transition hover:bg-slate-800"
                      aria-label="Clear Search"
                    >
                      X
                    </button>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => void searchHome()}
                  className="mx-auto block rounded-md bg-cyan-500 px-6 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
                >
                  Search
                </button>
              </div>

              <div className="space-y-3">
                {homeResults.length > 0 && (
                  <div className="space-y-3">
                    {homeResults.map((item) => (
                      <article key={item.consumerNumber} className="space-y-2 rounded-lg border border-slate-800 bg-slate-900 p-4 text-sm">
                        <p><span className="text-slate-400">Consumer Number:</span> {item.consumerNumber}</p>
                        <p><span className="text-slate-400">Consumer Name:</span> {item.consumerName}</p>
                        <p><span className="text-slate-400">Mobile Number:</span> {item.mobileNumber}</p>
                        <p><span className="text-slate-400">Landmark:</span> {item.landmark}</p>
                        <p><span className="text-slate-400">Full Location Coordinates:</span> {item.latitude}, {item.longitude}</p>
                        <button
                          type="button"
                          onClick={() => openImageViewer(item.imagePath)}
                          className="w-full rounded-md border border-slate-700 bg-slate-950 p-2"
                        >
                          <img src={item.imagePath} alt={item.consumerName} className="h-52 w-full object-contain" />
                        </button>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                          <a
                            href={`tel:${item.mobileNumber}`}
                            className="rounded-md border border-slate-700 px-3 py-2 text-center transition hover:border-slate-500"
                          >
                            Call Consumer
                          </a>
                          <button
                            type="button"
                            onClick={() => openSavedLocation(item)}
                            className="rounded-md border border-slate-700 px-3 py-2 text-center transition hover:border-slate-500"
                          >
                            View Location
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}

                {hasSearchedHome && homeResults.length === 0 ? (
                  <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 text-sm">
                    <p className="font-semibold">No consumer found.</p>
                    <p className="text-slate-400">Please check number, name, mobile or landmark and try again.</p>
                  </div>
                ) : null}
              </div>

              <button
                type="button"
                onClick={() => setScreen("list")}
                className="w-full rounded-md border border-slate-700 px-4 py-3 text-left text-sm font-semibold transition hover:border-slate-500"
              >
                View Saved Consumers
              </button>
            </motion.section>
          )}

          {(screen === "add" || screen === "edit") && (
            <motion.section key="form" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-4">
              <h2 className="text-base font-semibold">{screen === "add" ? "Add Consumer" : `Edit Consumer ${editingNumber ?? ""}`}</h2>

              <label className="space-y-1 text-sm">
                <span>Consumer Number (6 digits)</span>
                <input
                  value={formState.consumerNumber}
                  onChange={(event) => updateForm("consumerNumber", event.target.value.replace(/\D/g, "").slice(0, 6))}
                  disabled={screen === "edit"}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-cyan-400 disabled:opacity-70"
                />
              </label>

              <label className="space-y-1 text-sm">
                <span>Consumer Name</span>
                <input
                  value={formState.consumerName}
                  onChange={(event) => updateForm("consumerName", event.target.value)}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-cyan-400"
                />
              </label>

              <label className="space-y-1 text-sm">
                <span>Mobile Number (10 digits)</span>
                <input
                  value={formState.mobileNumber}
                  onChange={(event) => updateForm("mobileNumber", event.target.value.replace(/\D/g, "").slice(0, 10))}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-cyan-400"
                />
              </label>

              <label className="space-y-1 text-sm">
                <span>Landmark</span>
                <textarea
                  value={formState.landmark}
                  onChange={(event) => updateForm("landmark", event.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-cyan-400"
                />
              </label>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => void handlePickImage(CameraSource.Camera)}
                  className="rounded-md border border-slate-700 px-3 py-2 text-sm transition hover:border-slate-500"
                >
                  Take Photo
                </button>
                <button
                  type="button"
                  onClick={() => void handlePickImage(CameraSource.Photos)}
                  className="rounded-md border border-slate-700 px-3 py-2 text-sm transition hover:border-slate-500"
                >
                  Select Image
                </button>
              </div>

              {formState.imagePath ? (
                <img src={formState.imagePath} alt="Consumer" className="h-44 w-full rounded-md border border-slate-700 object-cover" />
              ) : null}

              <button
                type="button"
                onClick={() => void handleCaptureLocation()}
                className="rounded-md border border-slate-700 px-3 py-2 text-sm transition hover:border-slate-500"
              >
                Capture Current Location
              </button>

              <p className="text-xs text-slate-300">
                Latitude: {formState.latitude || "-"} | Longitude: {formState.longitude || "-"}
              </p>
              <p className="text-xs text-slate-400">Location Timestamp: {formState.locationTimestamp ? formatDateTime(formState.locationTimestamp) : "-"}</p>

              <label className="space-y-1 text-sm">
                <span>Master Password</span>
                <input
                  type="password"
                  value={formState.masterPassword}
                  onChange={(event) => updateForm("masterPassword", event.target.value)}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-cyan-400"
                />
              </label>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => void saveConsumer()}
                  className="rounded-md bg-emerald-500 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400"
                >
                  Save Consumer
                </button>
                <button
                  type="button"
                  onClick={resetAndGoHome}
                  className="rounded-md border border-slate-700 px-3 py-2 text-sm transition hover:border-slate-500"
                >
                  Cancel
                </button>
              </div>
            </motion.section>
          )}

          {screen === "list" && (
            <motion.section key="list" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="space-y-3">
              <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
                <p className="text-sm">Total Consumers Saved: {activeConsumers.length}</p>
              </div>

              <input
                value={listSearch}
                onChange={(event) => setListSearch(event.target.value)}
                placeholder="Search all consumers"
                className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-cyan-400"
              />

              <div className="space-y-3">
                {listResults.map((item) => (
                  <article key={item.consumerNumber} className="space-y-2 rounded-lg border border-slate-800 bg-slate-900 p-4 text-sm">
                    <p><span className="text-slate-400">Consumer Number:</span> {item.consumerNumber}</p>
                    <p><span className="text-slate-400">Consumer Name:</span> {item.consumerName}</p>
                    <p><span className="text-slate-400">Mobile:</span> {item.mobileNumber}</p>
                    <p><span className="text-slate-400">Landmark:</span> {item.landmark}</p>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => openEditConsumer(item)}
                        className="rounded-md border border-slate-700 px-3 py-2 text-sm transition hover:border-slate-500"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => void deleteConsumer(item)}
                        className="rounded-md border border-rose-600 px-3 py-2 text-sm text-rose-300 transition hover:bg-rose-600/10"
                      >
                        Delete
                      </button>
                    </div>
                  </article>
                ))}
              </div>

              <button
                type="button"
                onClick={() => setScreen("home")}
                className="rounded-md border border-slate-700 px-3 py-2 text-sm transition hover:border-slate-500"
              >
                Back
              </button>
            </motion.section>
          )}

          {screen === "admin" && (
            <motion.section key="admin" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-4">
              <h2 className="text-base font-semibold">Admin Settings</h2>
              <p className="text-sm text-slate-300">Save Master Password updates to Firebase so every user receives it automatically.</p>
              <label className="space-y-1 text-sm">
                <span>New Master Password</span>
                <input
                  type="password"
                  value={adminNewPassword}
                  onChange={(event) => setAdminNewPassword(event.target.value)}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-cyan-400"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span>Confirm Master Password</span>
                <input
                  type="password"
                  value={adminConfirmPassword}
                  onChange={(event) => setAdminConfirmPassword(event.target.value)}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 outline-none focus:border-cyan-400"
                />
              </label>
              <button
                type="button"
                onClick={() => void saveMasterPassword()}
                className="rounded-md bg-cyan-500 px-3 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-400"
              >
                Save Master Password
              </button>
              <button
                type="button"
                onClick={() => setScreen("home")}
                className="rounded-md border border-slate-700 px-3 py-2 text-sm transition hover:border-slate-500"
              >
                Back
              </button>
            </motion.section>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {viewerImagePath ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 flex flex-col bg-black/95 p-4"
            >
              <div className="mx-auto flex w-full max-w-4xl items-center justify-between">
                <p className="text-sm text-slate-200">Image Viewer</p>
                <button
                  type="button"
                  onClick={() => setViewerImagePath(null)}
                  className="rounded-md border border-slate-700 px-3 py-2 text-sm"
                >
                  Close
                </button>
              </div>

              <div className="mx-auto mt-3 flex w-full max-w-4xl justify-center gap-2">
                <button type="button" onClick={() => updateZoom(viewerZoom - 0.25)} className="rounded-md border border-slate-700 px-3 py-2 text-sm">
                  -
                </button>
                <button type="button" onClick={() => updateZoom(1)} className="rounded-md border border-slate-700 px-3 py-2 text-sm">
                  Reset
                </button>
                <button type="button" onClick={() => updateZoom(viewerZoom + 0.25)} className="rounded-md border border-slate-700 px-3 py-2 text-sm">
                  +
                </button>
              </div>

              <div className="mt-4 flex flex-1 items-center justify-center overflow-auto">
                <img
                  src={viewerImagePath}
                  alt="Consumer Fullscreen"
                  className="max-h-full w-full object-contain"
                  style={{ transform: `scale(${viewerZoom})`, transformOrigin: "center center" }}
                />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </main>

      <motion.button
        whileTap={{ scale: 0.9 }}
        animate={{ y: [0, -2, 0] }}
        transition={{ repeat: Infinity, duration: 1.8 }}
        onPointerDown={startAddButtonPress}
        onPointerUp={endAddButtonPress}
        onPointerLeave={endAddButtonPress}
        className="fixed right-6 bottom-6 flex h-14 w-14 items-center justify-center rounded-full bg-cyan-500 text-3xl font-semibold text-slate-950 shadow-lg shadow-cyan-600/30"
        aria-label="Add Consumer"
      >
        +
      </motion.button>
    </div>
  );
}
