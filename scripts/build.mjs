import { build, context } from "esbuild";

const options = {
  entryPoints: ["src/service_worker.ts", "src/popup.ts", "src/options.ts"],
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  outdir: "dist",
  sourcemap: true,
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("Watching src/**/*.ts");
} else {
  await build(options);
}
