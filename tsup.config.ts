import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  sourcemap: true,
  clean: true,
  target: "node22",
  splitting: false,
  treeshake: true,
});
