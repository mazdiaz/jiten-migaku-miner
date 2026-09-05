import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  server: {
    host: "127.0.0.1",
    port: 8920,
  },
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        legacy: "jiten-migaku-miner-v1.html",
      },
    },
    outDir: "dist",
    emptyOutDir: true,
  },
});
