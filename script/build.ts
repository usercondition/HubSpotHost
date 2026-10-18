import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { cp, rm, readFile } from "node:fs/promises";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
// express is intentionally NOT bundled so Sentry can instrument it at require time.
const allowlist = [
  "@google/generative-ai",
  "axios",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  // ESM-only (type: module); keep bundling it into the CJS server like before it was a declared dependency.
  "meshoptimizer",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  const serverBuild = {
    platform: "node" as const,
    bundle: true,
    format: "cjs" as const,
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info" as const,
  };
  await esbuild({ ...serverBuild, entryPoints: ["server/index.ts"], outfile: "dist/index.cjs" });
  await esbuild({ ...serverBuild, entryPoints: ["server/lib/plate-mesh-worker.ts"], outfile: "dist/plate-mesh-worker.cjs" });
  // Sentry init is loaded with `node --import` before the app bundle (ESM so
  // the SDK can register both its ESM and CJS module hooks).
  await esbuild({ ...serverBuild, format: "esm", entryPoints: ["server/instrument.ts"], outfile: "dist/instrument.mjs" });

  await cp("server/fonts", "dist/fonts", { recursive: true });
  await cp("shared/geo/us-zip-centroids.json", "dist/us-zip-centroids.json");
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
