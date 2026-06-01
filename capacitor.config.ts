import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.hp.deliveryhelper",
  appName: "HP DELIVERY HELPER",
  webDir: "dist",
  bundledWebRuntime: false,
  plugins: {
    Camera: {
      permissions: ["camera", "photos"],
    },
  },
};

export default config;