const outDir = "./dist/client";
const publicDir = "./public";
const clientEntry = "./src/client/client.ts";

async function copyPublicDir(from: string, to: string) {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const src = `${from}/${entry.name}`;
    const dest = `${to}/${entry.name}`;
    if (entry.isDirectory) {
      await copyPublicDir(src, dest);
      continue;
    }
    if (!entry.name.endsWith(".zip")) {
      await Deno.copyFile(src, dest);
    }
  }
}

await Deno.remove(outDir, { recursive: true }).catch((error: unknown) => {
  if (!(error instanceof Deno.errors.NotFound)) throw error;
});
await Deno.mkdir(outDir, { recursive: true });
await copyPublicDir(publicDir, outDir);

const bundle = new Deno.Command(Deno.execPath(), {
  args: [
    "bundle",
    "--platform=browser",
    "--sourcemap=linked",
    "--output",
    `${outDir}/client.js`,
    clientEntry,
  ],
  stdout: "inherit",
  stderr: "inherit",
});

const { success } = await bundle.output();
if (!success) {
  throw new Error("Client bundle failed");
}

console.log("Build complete");
