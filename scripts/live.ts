let server: Deno.ChildProcess | null = null;
let restarting = false;
let pendingRestart = false;
let debounceTimer: number | undefined;

function runDenoTask(task: string): Deno.ChildProcess {
  return new Deno.Command(Deno.execPath(), {
    args: ["task", task],
    stdin: "null",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
}

async function build(): Promise<boolean> {
  const process = runDenoTask("build");
  const status = await process.status;
  return status.success;
}

function startServer() {
  const host = Deno.env.get("HOST") ?? "0.0.0.0";
  const port = Deno.env.get("PORT") ?? "8000";
  console.log(`Starting live server on ${host}:${port}`);
  console.log(`Open directly from LAN: http://<your-hostname>:${port}`);
  server = runDenoTask("start");
}

async function stopServer() {
  if (!server) return;

  const process = server;
  server = null;
  try {
    process.kill("SIGTERM");
    await process.status;
  } catch {
    // Process may already be gone after a build or source error.
  }
}

async function rebuildAndRestart() {
  if (restarting) {
    pendingRestart = true;
    return;
  }

  restarting = true;
  do {
    pendingRestart = false;
    await stopServer();
    if (await build()) {
      startServer();
    } else {
      console.error("Build failed; waiting for the next change.");
    }
  } while (pendingRestart);
  restarting = false;
}

function scheduleRestart() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void rebuildAndRestart(), 150);
}

async function shutdown() {
  await stopServer();
  Deno.exit(0);
}

Deno.addSignalListener("SIGINT", () => void shutdown());
Deno.addSignalListener("SIGTERM", () => void shutdown());

await rebuildAndRestart();

const watcher = Deno.watchFs(["src", "public", "build.ts", "deno.json"]);
for await (const event of watcher) {
  if (event.kind === "access") continue;
  scheduleRestart();
}
