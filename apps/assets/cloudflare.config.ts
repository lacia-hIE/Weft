import { defineConfig, bindings } from "cf/config";
import {deployment} from '../../scripts/deployment-config.ts';
export default defineConfig({
  worker: {
    name: deployment.uiWorkerName,
    entrypoint: "../../dist/assets-worker.js",
    compatibilityDate: "2026-07-30",
    workersDev: false,
    previewUrls: false,
    env: { ASSETS: bindings.assets() },
    assets: { runWorkerFirst: true, htmlHandling: "none", notFoundHandling: "none" },
  },
});
