import fs from "node:fs";
import path from "node:path";
import { build, context } from "esbuild";
import { GECKO_TARGETS, createGeckoManifest } from "./lib/gecko_manifest.mjs";

const target = readTarget(process.argv.slice(2));
const root = process.cwd();
const sharedOptions = {
  entryPoints: ["src/service_worker.ts", "src/popup.ts", "src/options.ts"],
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  sourcemap: true
};

if (target === "chrome") {
  await runBuild({ ...sharedOptions, target: "chrome120", outdir: "dist" });
} else {
  const outRoot = path.join("build", target);
  fs.rmSync(outRoot, { recursive: true, force: true });
  await runBuild({ ...sharedOptions, target: "firefox142", outdir: path.join(outRoot, "dist") });
  writeGeckoPackage(outRoot, GECKO_TARGETS[target]);
}

function readTarget(args) {
  const index = args.indexOf("--target");
  const value = index === -1 ? "chrome" : args[index + 1];
  if (value !== "chrome" && !Object.hasOwn(GECKO_TARGETS, value)) {
    throw new Error(`Unsupported build target "${value}". Supported: chrome, ${Object.keys(GECKO_TARGETS).join(", ")}.`);
  }
  return value;
}

async function runBuild(options) {
  if (process.argv.includes("--watch")) {
    const ctx = await context(options);
    await ctx.watch();
    console.log(`Watching src/**/*.ts for ${target}`);
    return;
  }
  await build(options);
}

function writeGeckoPackage(outRoot, geckoTarget) {
  const chromeManifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const manifest = createGeckoManifest(chromeManifest, geckoTarget);
  fs.writeFileSync(path.join(outRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const file of ["popup.html", "options.html", "styles.css", "LICENSE"]) {
    fs.copyFileSync(path.join(root, file), path.join(outRoot, file));
  }
  if (geckoTarget.zenFolders) {
    fs.cpSync(path.join(root, "experiments", "zen_folders"), path.join(outRoot, "experiments", "zen_folders"), { recursive: true });
  }
}
