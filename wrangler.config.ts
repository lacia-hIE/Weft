import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
	noBundle: true,
	types: {
		generate: false,
	},
});
