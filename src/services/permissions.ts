import { Camera } from "@capacitor/camera";
import { Geolocation } from "@capacitor/geolocation";
import { Preferences } from "@capacitor/preferences";

const PERMISSION_FLAG_KEY = "hp_permissions_requested";

export const requestInitialPermissions = async (): Promise<void> => {
  const { value } = await Preferences.get({ key: PERMISSION_FLAG_KEY });
  if (value === "true") return;

  try {
    await Camera.requestPermissions({ permissions: ["camera", "photos"] });
  } catch (error) {
    console.warn("Camera permissions were denied or unavailable", error);
  }

  try {
    await Geolocation.requestPermissions();
  } catch (error) {
    console.warn("Location permission was denied or unavailable", error);
  }

  await Preferences.set({ key: PERMISSION_FLAG_KEY, value: "true" });
};