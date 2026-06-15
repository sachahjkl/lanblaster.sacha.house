import ts from "typescript";

const outDir = "./dist/client";

const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
const THREE_WEBGPU_URL =
  "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/renderers/webgpu/WebGPURenderer.js";

await Deno.mkdir(outDir, { recursive: true });

async function transpileFile(path: string, outPath: string) {
  const source = await Deno.readTextFile(path);
  const result = ts.transpileModule(source, {
    compilerOptions: {
      module: 99, // ESNext
      target: 9, // ES2022
      lib: ["dom", "dom.iterable", "esnext"],
      moduleResolution: 100, // Bundler
      esModuleInterop: true,
      skipLibCheck: true,
    },
  });

  let code = result.outputText;

  // Rewrite npm imports to CDN URLs for the browser
  code = code.replace(/from\s+["']three["']/g, `from "${THREE_URL}"`);
  code = code.replace(
    /from\s+["']three\/(?:examples\/jsm|addons)\/renderers\/(?:webgpu\/)?WebGPURenderer\.js["']/g,
    `from "${THREE_WEBGPU_URL}"`,
  );
  code = code.replace(
    /from\s+["']three\/examples\/jsm\/([^"']+)["']/g,
    (_match, path) => `from "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/${path}"`,
  );

  // Rewrite local .ts imports to .js
  code = code.replace(/from\s+["'](\.\/[^"']+)\.ts["']/g, `from "$1.js"`);
  code = code.replace(/from\s+["'](\.\.\/[^"']+)\.ts["']/g, `from "$1.js"`);

  await Deno.writeTextFile(outPath, code);
}

async function copyPublicDir(from: string, to: string) {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const src = `${from}/${entry.name}`;
    const dest = `${to}/${entry.name}`;
    if (entry.isDirectory) {
      await copyPublicDir(src, dest);
    } else if (!entry.name.endsWith(".zip")) {
      await Deno.copyFile(src, dest);
    }
  }
}

// Transpile client source files
const files = [
  "src/client/client.ts",
  "src/client/audio.ts",
  "src/client/input.ts",
  "src/client/renderer.ts",
  "src/shared/settings.ts",
  "src/shared/protocol.ts",
  "src/shared/physics.ts",
];

for (const file of files) {
  const outPath = file.replace("src/", "dist/client/").replace(".ts", ".js");
  await Deno.mkdir(outPath.replace(/\/[^/]+$/, ""), { recursive: true });
  await transpileFile(file, outPath);
}

// Copy public assets recursively, skipping source zip archives.
await copyPublicDir("./public", outDir);

console.log("Build complete");
