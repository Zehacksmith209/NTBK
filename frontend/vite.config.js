import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the built bundle loads straight off disk in the
  // pywebview window — there is no server at runtime.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: { manualChunks: undefined },
    },
  },
  server: { port: 5273 },
});
