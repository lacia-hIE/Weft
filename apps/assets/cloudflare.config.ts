import { defineConfig } from "cf/config";
export default defineConfig({
  worker: {
    name: "weft-ui-assets",
    entrypoint: "../../dist/assets-worker.js",
    compatibilityDate: "2026-07-30",
    workersDev: false,
    previewUrls: false,
  },
});
