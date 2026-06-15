import {
  ClientMsg,
  ClientStateUpdate,
  FireEvent,
  JUMP_PADS,
  PlayerInput,
  PlayerState,
  ServerMsg,
  Snapshot,
  SNAPSHOOT_RATE,
  TICK_DT,
  TICK_RATE,
  Vec3,
  WEAPONS,
  clonePlayerState,
  getWeapon,
} from "../shared/protocol.ts";
import {
  aimTargetPoint,
  applyInput,
  createPlayer,
  muzzlePosition,
  stepPlayer,
} from "../shared/physics.ts";
import { SETTINGS } from "../shared/settings.ts";
import { AudioManager } from "./audio.ts";
import { InputManager } from "./input.ts";
import { GameRenderer } from "./renderer.ts";
import { RendererSettings } from "./renderer.ts";

const MAX_SNAPSHOT_HISTORY = SETTINGS.net.maxSnapshotHistory;

interface SnapshotEntry {
  snapshot: Snapshot;
  receivedAt: number;
}

interface GameSettings extends RendererSettings {
  headSway: boolean;
  masterVolume: number;
  music: boolean;
  musicVolume: number;
  sfx: boolean;
  sfxVolume: number;
}

const DEFAULT_SETTINGS: GameSettings = {
  brightness: 1.28,
  headSway: false,
  masterVolume: 0.8,
  music: true,
  musicVolume: 0.35,
  shadows: true,
  sfx: true,
  sfxVolume: 1,
};

function loadSettings(): GameSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem("gameSettings") ?? "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings: GameSettings) {
  localStorage.setItem("gameSettings", JSON.stringify(settings));
}

class GameClient {
  ws: WebSocket | null = null;
  input = new InputManager();
  audio = new AudioManager();
  renderer: GameRenderer;
  playerName: string;
  settings: GameSettings;
  onDisconnect: (reason: string) => void;

  localId: string | null = null;
  localState: PlayerState = createPlayer("local");
  previousLocalState: PlayerState = clonePlayerState(this.localState);
  lastSimulationTime = performance.now();

  inputSeq = 0;
  localLastFireSeq = -9999;
  pendingFire = false;
  pendingReload = false;

  snapshots: SnapshotEntry[] = [];
  remoteVisualStates = new Map<string, PlayerState>();

  hudWeapon = document.getElementById("weapon") as HTMLDivElement;
  hudAmmo = document.getElementById("ammo") as HTMLDivElement;
  hudHpFill = document.getElementById("hp-fill") as HTMLDivElement;
  hudHpText = document.getElementById("hp-text") as HTMLDivElement;
  pickupToast = document.getElementById("pickup-toast") as HTMLDivElement;

  lastRenderTime = performance.now();
  ping = 50;
  pickupToastUntil = 0;
  serverStartedAt: string | null = null;
  lastJumpPadSeq = 0;
  stopped = false;
  started = false;
  localSimulationTimer = 0;
  stateFlushTimer = 0;
  healthTimer = 0;

  constructor(
    playerName: string,
    ws: WebSocket,
    welcome: Extract<ServerMsg, { type: "welcome" }>,
    settings: GameSettings,
    onDisconnect: (reason: string) => void,
  ) {
    this.playerName = playerName;
    this.settings = settings;
    this.onDisconnect = onDisconnect;
    this.ws = ws;
    const canvas = document.getElementById("game") as HTMLCanvasElement;
    this.renderer = new GameRenderer(canvas);
    this.renderer.applySettings(settings);
    this.audio.startPadHum();
    this.audio.applySettings(settings);

    window.addEventListener("resize", () => this.onResize());
    this.onResize();

    this.ws.onmessage = (ev) => this.onMessage(ev.data);
    this.ws.onclose = (event) => this.onClose(event);
    this.acceptWelcome(welcome);
  }

  get ready(): Promise<void> {
    return this.renderer.ready;
  }

  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.localSimulationTimer = setInterval(() => this.tickLocalSimulation(), TICK_DT);
    this.stateFlushTimer = setInterval(() => this.flushState(), 1000 / SNAPSHOOT_RATE);
    this.healthTimer = setInterval(() => void this.checkServerHealth(), 3000);
    void this.checkServerHealth();
    requestAnimationFrame((time) => this.renderLoop(time));
  }

  onClose(event: CloseEvent) {
    console.log("Disconnected", event.reason);
    if (!this.localId || !this.started) {
      this.stop();
      this.onDisconnect(event.reason || "Could not join match");
    }
  }

  stop() {
    this.stopped = true;
    if (this.started) {
      clearInterval(this.localSimulationTimer);
      clearInterval(this.stateFlushTimer);
      clearInterval(this.healthTimer);
    }
  }

  async checkServerHealth() {
    try {
      const response = await fetch("/health", { cache: "no-store" });
      if (!response.ok) return;

      const status = (await response.json()) as { startedAt?: string };
      if (!status.startedAt) return;

      if (this.serverStartedAt && status.startedAt !== this.serverStartedAt) {
        window.location.reload();
        return;
      }

      this.serverStartedAt = status.startedAt;
    } catch {
      // Server may be temporarily unavailable while restarting.
    }
  }

  onResize() {
    const canvas = this.renderer.renderer.domElement;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    this.renderer.resize(window.innerWidth, window.innerHeight);
  }

  acceptWelcome(msg: Extract<ServerMsg, { type: "welcome" }>) {
    this.localId = msg.id;
    this.localState.id = msg.id;
    this.localState.name = this.playerName;
    this.renderer.setLocalPlayer(msg.id);
    console.log("Local id", msg.id);
  }

  onMessage(data: string) {
    const msg = JSON.parse(data) as ServerMsg;
    if (msg.type === "welcome") {
      this.acceptWelcome(msg);
    } else if (msg.type === "snapshot") {
      this.snapshots.push({ snapshot: msg.snapshot, receivedAt: performance.now() });
      if (this.snapshots.length > MAX_SNAPSHOT_HISTORY) this.snapshots.shift();
      this.renderer.updatePickups(msg.snapshot.pickups);
      this.applyAuthoritativeNonMovementState(msg.snapshot);
    } else if (msg.type === "fire") {
      this.onFireEvent(msg.event);
    } else if (msg.type === "hit") {
      if (msg.victimId === this.localId) {
        this.localState.hp = msg.hp;
        this.audio.playHit();
      }
    } else if (msg.type === "pong") {
      this.ping = (performance.now() - msg.clientTime) * 0.5;
    } else if (msg.type === "pickup") {
      this.pickupToast.textContent = `Picked up ${msg.label}`;
      this.pickupToastUntil = performance.now() + 1800;
    }
  }

  applyAuthoritativeNonMovementState(snapshot: Snapshot) {
    if (!this.localId) return;
    const serverState = snapshot.players.find((p) => p.id === this.localId);
    if (!serverState) return;

    // Server owns combat/death/respawn. Client owns normal movement.
    if (this.localState.dead && !serverState.dead) {
      this.localState = clonePlayerState(serverState);
      this.previousLocalState = clonePlayerState(serverState);
      this.localLastFireSeq = -9999;
      return;
    }

    this.localState.hp = serverState.hp;
    this.localState.maxHp = serverState.maxHp;
    this.localState.dead = serverState.dead;
    this.localState.respawnTick = serverState.respawnTick;
    this.localState.crouching = serverState.crouching;
    this.localState.aiming = serverState.aiming;
    if (serverState.jumpPadSeq > this.lastJumpPadSeq) {
      this.audio.playJumpPad();
      this.lastJumpPadSeq = serverState.jumpPadSeq;
    }
    this.localState.jumpPadSeq = serverState.jumpPadSeq;
    this.localState.weaponId = serverState.weaponId;
    this.localState.ammo = serverState.ammo;
    this.localState.lastFireTick = serverState.lastFireTick;
  }

  onFireEvent(ev: FireEvent) {
    if (ev.shooterId === this.localId) return;

    this.audio.playShoot();
    const origin = ev.origin;
    const dir = ev.direction;
    const maxLen = 200;
    const end: Vec3 = ev.hitPos ?? {
      x: origin.x + dir.x * maxLen,
      y: origin.y + dir.y * maxLen,
      z: origin.z + dir.z * maxLen,
    };
    this.renderer.addTracer(origin, end);
  }

  send(msg: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  flushState() {
    if (!this.localId) return;
    const weaponIndex = WEAPONS.findIndex((weapon) => weapon.id === this.localState.weaponId);
    const state: ClientStateUpdate = {
      seq: this.inputSeq,
      pos: { ...this.localState.pos },
      vel: { ...this.localState.vel },
      yaw: this.localState.yaw,
      pitch: this.localState.pitch,
      grounded: this.localState.grounded,
      crouching: this.localState.crouching,
      aiming: this.localState.aiming,
      jumpPadSeq: this.localState.jumpPadSeq,
      weaponIndex: Math.max(0, weaponIndex),
      fire: this.pendingFire,
      reload: this.pendingReload,
    };

    this.send({ type: "state", state });
    this.pendingFire = false;
    this.pendingReload = false;
  }

  applyInputPrediction(input: PlayerInput) {
    const desiredWeapon = WEAPONS[input.weaponIndex];
    if (desiredWeapon.id !== this.localState.weaponId) {
      this.localState.weaponId = desiredWeapon.id;
      this.localState.ammo = desiredWeapon.maxAmmo;
    }
    if (input.reload) {
      this.localState.ammo = desiredWeapon.maxAmmo;
    }

    applyInput(this.localState, input);
    const jumpPadSeqBefore = this.localState.jumpPadSeq;
    stepPlayer(this.localState, TICK_DT / 1000);
    if (this.localState.jumpPadSeq > jumpPadSeqBefore) {
      this.audio.playJumpPad();
      this.lastJumpPadSeq = this.localState.jumpPadSeq;
    }

    if (input.fire && !this.localState.dead && this.localState.ammo > 0) {
      const weapon = getWeapon(this.localState.weaponId);
      const cooldownTicks = Math.max(1, Math.ceil((weapon.cooldownMs / 1000) * TICK_RATE));
      if (input.seq - this.localLastFireSeq >= cooldownTicks) {
        this.localLastFireSeq = input.seq;
        this.localState.ammo--;
        this.audio.playShoot();
        const origin = muzzlePosition(this.localState);
        const aimPoint = aimTargetPoint(this.localState, SETTINGS.combat.fireMaxDistance);
        this.renderer.addTracer(origin, aimPoint);
      }
    }
  }

  tickLocalSimulation() {
    if (!this.localId || this.localState.dead) return;

    const wasGrounded = this.localState.grounded;
    this.previousLocalState = clonePlayerState(this.localState);
    this.inputSeq++;

    const input = this.input.sample(this.inputSeq);
    if (input.jump && wasGrounded) this.audio.playJump();
    if (input.reload) this.audio.playReload();
    this.pendingFire ||= input.fire;
    this.pendingReload ||= input.reload;
    this.applyInputPrediction(input);

    const horizontalSpeed = Math.hypot(this.localState.vel.x, this.localState.vel.z);
    if (this.localState.grounded && horizontalSpeed > 0.5) {
      this.audio.playFootstep();
    }
    this.lastSimulationTime = performance.now();
  }

  getRenderedLocalState(now: number): PlayerState {
    const alpha = Math.max(0, Math.min(1, (now - this.lastSimulationTime) / TICK_DT));
    return {
      ...this.localState,
      pos: {
        x:
          this.previousLocalState.pos.x +
          (this.localState.pos.x - this.previousLocalState.pos.x) * alpha,
        y:
          this.previousLocalState.pos.y +
          (this.localState.pos.y - this.previousLocalState.pos.y) * alpha,
        z:
          this.previousLocalState.pos.z +
          (this.localState.pos.z - this.previousLocalState.pos.z) * alpha,
      },
      yaw:
        this.previousLocalState.yaw + (this.localState.yaw - this.previousLocalState.yaw) * alpha,
      pitch:
        this.previousLocalState.pitch +
        (this.localState.pitch - this.previousLocalState.pitch) * alpha,
    };
  }

  updateHUD() {
    const p = this.localState;
    const weapon = getWeapon(p.weaponId);
    this.hudWeapon.textContent = weapon.name;
    this.hudAmmo.textContent = `${p.ammo} / ${weapon.maxAmmo}`;
    const hpRatio = Math.max(0, p.hp / p.maxHp);
    this.hudHpFill.style.width = `${hpRatio * 100}%`;
    this.hudHpFill.style.backgroundColor =
      hpRatio > 0.5 ? "#0f0" : hpRatio > 0.25 ? "#ff0" : "#f00";
    this.hudHpText.textContent = `${Math.max(0, p.hp)} / ${p.maxHp}`;
    this.pickupToast.hidden = performance.now() > this.pickupToastUntil;
  }

  renderLoop(now: number) {
    if (this.stopped) return;

    const renderDt = Math.min(100, now - this.lastRenderTime) / 1000;
    this.lastRenderTime = now;

    const renderedLocalState = this.getRenderedLocalState(now);
    this.renderer.setCameraFromPlayer(
      renderedLocalState,
      renderDt,
      this.settings.headSway,
      this.input.lean,
      this.input.aiming,
    );
    this.renderer.updatePlayer(renderedLocalState, true);
    this.renderer.updateFirstPersonWeapon(renderedLocalState, renderDt, this.input.aiming);
    this.updateRemotePlayers(renderDt);
    this.renderer.updateMovingPlatforms(now);
    this.renderer.updateTracers(renderDt);
    this.updatePadHum(renderedLocalState);
    this.updateHUD();
    this.renderer.render();

    if (!this.stopped) requestAnimationFrame((time) => this.renderLoop(time));
  }

  updatePadHum(state: PlayerState) {
    let strongest = 0;
    for (const pad of JUMP_PADS) {
      const cx = (pad.min.x + pad.max.x) * 0.5;
      const cy = (pad.min.y + pad.max.y) * 0.5;
      const cz = (pad.min.z + pad.max.z) * 0.5;
      const dist = Math.hypot(state.pos.x - cx, state.pos.y - cy, state.pos.z - cz);
      strongest = Math.max(strongest, 1 - dist / 18);
    }
    this.audio.setPadHumIntensity(strongest);
  }

  updateRemotePlayers(dt: number) {
    const latestEntry = this.snapshots[this.snapshots.length - 1];
    if (!latestEntry) return;

    const latest = latestEntry.snapshot;
    const extrapolateDt = Math.min(0.1, (performance.now() - latestEntry.receivedAt) / 1000);
    const smoothing = 1 - Math.exp(-35 * dt);
    const seen = new Set<string>();

    for (const target of latest.players) {
      if (target.id === this.localId) continue;
      seen.add(target.id);

      const current = this.remoteVisualStates.get(target.id) ?? clonePlayerState(target);
      const targetPos = target.dead
        ? target.pos
        : {
            x: target.pos.x + target.vel.x * extrapolateDt,
            y: target.pos.y + target.vel.y * extrapolateDt,
            z: target.pos.z + target.vel.z * extrapolateDt,
          };

      current.pos.x += (targetPos.x - current.pos.x) * smoothing;
      current.pos.y += (targetPos.y - current.pos.y) * smoothing;
      current.pos.z += (targetPos.z - current.pos.z) * smoothing;
      current.vel = target.vel;
      current.yaw += (target.yaw - current.yaw) * smoothing;
      current.pitch += (target.pitch - current.pitch) * smoothing;
      current.grounded = target.grounded;
      current.crouching = target.crouching;
      current.aiming = target.aiming;
      current.name = target.name;
      current.hp = target.hp;
      current.maxHp = target.maxHp;
      current.dead = target.dead;
      current.respawnTick = target.respawnTick;
      current.weaponId = target.weaponId;
      current.ammo = target.ammo;
      current.lastFireTick = target.lastFireTick;
      current.lastProcessedInputSeq = target.lastProcessedInputSeq;

      this.remoteVisualStates.set(target.id, current);
      this.renderer.updatePlayer(current, false);
    }

    for (const id of this.remoteVisualStates.keys()) {
      if (!seen.has(id)) {
        this.remoteVisualStates.delete(id);
        this.renderer.removePlayer(id);
      }
    }
  }
}

const titleScreen = document.getElementById("title-screen") as HTMLDivElement;
const nameForm = document.getElementById("name-form") as HTMLFormElement;
const nameInput = document.getElementById("player-name") as HTMLInputElement;
const nameError = document.getElementById("name-error") as HTMLDivElement;
const playButton = document.getElementById("play-button") as HTMLButtonElement;
const loadingStatus = document.getElementById("loading-status") as HTMLDivElement;
const loadingTip = document.getElementById("loading-tip") as HTMLDivElement;
const pauseMenu = document.getElementById("pause-menu") as HTMLDivElement;
const optionsButton = document.getElementById("options-button") as HTMLButtonElement;
const resumeButton = document.getElementById("resume-button") as HTMLButtonElement;
const headSwayToggle = document.getElementById("head-sway-toggle") as HTMLInputElement;
const masterVolumeSlider = document.getElementById("master-volume-slider") as HTMLInputElement;
const musicToggle = document.getElementById("music-toggle") as HTMLInputElement;
const musicVolumeSlider = document.getElementById("music-volume-slider") as HTMLInputElement;
const sfxToggle = document.getElementById("sfx-toggle") as HTMLInputElement;
const sfxVolumeSlider = document.getElementById("sfx-volume-slider") as HTMLInputElement;
const shadowsToggle = document.getElementById("shadows-toggle") as HTMLInputElement;
const brightnessSlider = document.getElementById("brightness-slider") as HTMLInputElement;
const brightnessValue = document.getElementById("brightness-value") as HTMLSpanElement;

const settings = loadSettings();
let activeClient: GameClient | null = null;
const LOADING_TIPS = [
  "Tip: Bounce pads are the fastest way to contest high ground.",
  "Tip: Crouch routes are quiet shortcuts through enemy pressure.",
  "Tip: Moving platforms preserve momentum. Jump late for extra reach.",
  "Tip: Rifle controls lanes; sniper controls tower sightlines.",
] as const;
let loadingTipTimer = 0;

nameInput.value = localStorage.getItem("playerName") ?? "";
headSwayToggle.checked = settings.headSway;
masterVolumeSlider.value = String(settings.masterVolume);
musicToggle.checked = settings.music;
musicVolumeSlider.value = String(settings.musicVolume);
sfxToggle.checked = settings.sfx;
sfxVolumeSlider.value = String(settings.sfxVolume);
shadowsToggle.checked = settings.shadows;
brightnessSlider.value = String(settings.brightness);
brightnessValue.textContent = `${Math.round(settings.brightness * 100)}%`;
nameInput.focus();

function applyGraphicsSettings() {
  brightnessValue.textContent = `${Math.round(settings.brightness * 100)}%`;
  saveSettings(settings);
  activeClient?.renderer.applySettings(settings);
}

function applyAudioSettings() {
  saveSettings(settings);
  activeClient?.audio.applySettings(settings);
}

function setLoading(status: string) {
  loadingStatus.textContent = status;
  loadingTip.textContent = LOADING_TIPS[Math.floor(performance.now() / 5000) % LOADING_TIPS.length];
  clearInterval(loadingTipTimer);
  loadingTipTimer = setInterval(() => {
    loadingTip.textContent =
      LOADING_TIPS[Math.floor(performance.now() / 5000) % LOADING_TIPS.length];
  }, 1000);
}

function clearLoading() {
  clearInterval(loadingTipTimer);
  loadingStatus.textContent = "";
  loadingTip.textContent = "";
}

function setPauseMenuVisible(visible: boolean) {
  pauseMenu.hidden = !visible;
  if (visible && document.pointerLockElement) document.exitPointerLock();
}

window.addEventListener("keydown", (event) => {
  if (event.code !== "Escape" || !titleScreen.hidden) return;
  event.preventDefault();
  setPauseMenuVisible(pauseMenu.hidden === true);
});

resumeButton.addEventListener("click", () => setPauseMenuVisible(false));
optionsButton.addEventListener("click", () => setPauseMenuVisible(true));

headSwayToggle.addEventListener("change", () => {
  settings.headSway = headSwayToggle.checked;
  saveSettings(settings);
});

musicToggle.addEventListener("change", () => {
  settings.music = musicToggle.checked;
  applyAudioSettings();
});

masterVolumeSlider.addEventListener("input", () => {
  settings.masterVolume = Number(masterVolumeSlider.value);
  applyAudioSettings();
});

musicVolumeSlider.addEventListener("input", () => {
  settings.musicVolume = Number(musicVolumeSlider.value);
  applyAudioSettings();
});

sfxToggle.addEventListener("change", () => {
  settings.sfx = sfxToggle.checked;
  applyAudioSettings();
});

sfxVolumeSlider.addEventListener("input", () => {
  settings.sfxVolume = Number(sfxVolumeSlider.value);
  applyAudioSettings();
});

shadowsToggle.addEventListener("change", () => {
  settings.shadows = shadowsToggle.checked;
  applyGraphicsSettings();
});

brightnessSlider.addEventListener("input", () => {
  settings.brightness = Number(brightnessSlider.value);
  applyGraphicsSettings();
});

function connectForJoin(
  playerName: string,
): Promise<{ ws: WebSocket; welcome: Extract<ServerMsg, { type: "welcome" }> }> {
  return new Promise((resolve, reject) => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${proto}//${window.location.host}?name=${encodeURIComponent(playerName)}`,
    );

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data) as ServerMsg;
      if (msg.type !== "welcome") return;
      resolve({ ws, welcome: msg });
    };
    ws.onclose = (event) => reject(new Error(event.reason || "Could not join match"));
    ws.onerror = () => reject(new Error("Could not connect to server"));
  });
}

nameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const playerName = nameInput.value.trim().slice(0, 24) || "Player";
  nameError.textContent = "";
  playButton.disabled = true;
  playButton.textContent = "Joining...";
  setLoading("Dialing arena uplink...");
  localStorage.setItem("playerName", playerName);

  try {
    const { ws, welcome } = await connectForJoin(playerName);
    playButton.textContent = "Loading assets...";
    setLoading("Loading arena assets...");
    const client = new GameClient(playerName, ws, welcome, settings, (reason) => {
      activeClient = null;
      titleScreen.hidden = false;
      nameError.textContent = reason;
      playButton.disabled = false;
      playButton.textContent = "Join Match";
      clearLoading();
      nameInput.focus();
    });
    await client.ready;
    activeClient = client;
    clearLoading();
    titleScreen.hidden = true;
    client.start();
  } catch (err) {
    titleScreen.hidden = false;
    nameError.textContent = err instanceof Error ? err.message : "Could not join match";
    playButton.disabled = false;
    playButton.textContent = "Join Match";
    clearLoading();
    nameInput.focus();
  }
});
