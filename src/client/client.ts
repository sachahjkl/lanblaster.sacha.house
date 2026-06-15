import {
  ClientMsg,
  ClientStateUpdate,
  FireEvent,
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
import { DEFAULT_LEVEL_ID, LevelDefinition, getLevelData, LEVELS } from "../shared/mapData.ts";
import {
  applyInput,
  applySpread,
  createPlayer,
  currentSpreadForPlayer,
  eyePosition,
  lookDirection,
  muzzlePosition,
  pointOnRay,
  stepPlayer,
  updateSpreadAccum,
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
  level: LevelDefinition;
  localState: PlayerState;
  previousLocalState: PlayerState;
  lastSimulationTime = performance.now();
  roomId = "";
  roomName = "";
  levelId = DEFAULT_LEVEL_ID;
  isHost = false;
  localVisualStepOffsetY = 0;

  inputSeq = 0;
  localLastFireSeq = -9999;
  pendingFire = false;
  pendingReload = false;
  localReloadEndMs = 0;
  recoilPitch = 0;
  recoilYaw = 0;
  recoilRoll = 0;

  snapshots: SnapshotEntry[] = [];
  remoteVisualStates = new Map<string, PlayerState>();

  hudWeapon = document.getElementById("weapon") as HTMLDivElement;
  hudAmmo = document.getElementById("ammo") as HTMLDivElement;
  hudHpFill = document.getElementById("hp-fill") as HTMLDivElement;
  hudHpText = document.getElementById("hp-text") as HTMLDivElement;
  pickupToast = document.getElementById("pickup-toast") as HTMLDivElement;
  eventFeed = document.getElementById("event-feed") as HTMLDivElement;
  scoreboard = document.getElementById("scoreboard") as HTMLDivElement;
  scoreboardBody = document.getElementById("scoreboard-body") as HTMLTableSectionElement;
  deathScreen = document.getElementById("death-screen") as HTMLDivElement;
  deathMessage = document.getElementById("death-message") as HTMLParagraphElement;
  respawnButton = document.getElementById("respawn-button") as HTMLButtonElement;
  damageFlash = document.getElementById("damage-flash") as HTMLDivElement;
  sniperScope = document.getElementById("sniper-scope") as HTMLDivElement;
  chatContainer = document.getElementById("chat-container") as HTMLDivElement;
  chatInput = document.getElementById("chat-input") as HTMLInputElement;
  reconnectOverlay = document.getElementById("reconnect-overlay") as HTMLDivElement;
  reconnectMessage = document.getElementById("reconnect-message") as HTMLParagraphElement;
  reconnectProgressBar = document.getElementById("reconnect-progress-bar") as HTMLDivElement;
  interactHint = document.getElementById("interact-hint") as HTMLDivElement;

  lastRenderTime = performance.now();
  ping = 50;
  pickupToastUntil = 0;
  damageFlashUntil = 0;
  serverStartedAt: string | null = null;
  lastJumpPadSeq = 0;
  lastSnapshotTick = 0;
  lastSnapshotReceivedAt = performance.now();
  stopped = false;
  started = false;
  localSimulationTimer = 0;
  stateFlushTimer = 0;
  healthTimer = 0;
  lastKillerName = "";
  lastKillerWeapon = "";
  roomPassword = "";
  reconnecting = false;
  reconnectTimer = 0;
  reconnectDeadline = 0;
  reconnectAttemptCount = 0;
  canInteractFlag = false;

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
    this.level = getLevelData(welcome.levelId);
    this.localState = createPlayer("local", this.level);
    this.previousLocalState = clonePlayerState(this.localState);
    this.levelId = this.level.id;
    const canvas = document.getElementById("game") as HTMLCanvasElement;
    this.renderer = new GameRenderer(canvas, this.level);
    this.renderer.applySettings(settings);
    this.audio.startPadHum();
    this.audio.applySettings(settings);
    this.respawnButton.addEventListener("click", () => this.requestRespawn());
    this.chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.submitChat();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.closeChat();
      }
    });

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
      return;
    }
    this.beginReconnect(event.reason || "Connection lost");
  }

  stop() {
    this.stopped = true;
    if (this.started) {
      clearInterval(this.localSimulationTimer);
      clearInterval(this.stateFlushTimer);
      clearInterval(this.healthTimer);
    }
  }

  disconnect() {
    this.stop();
    try {
      this.ws?.close(1000, "Left room");
    } catch {
      // ignore
    }
    this.ws = null;
  }

  async checkServerHealth() {
    try {
      const response = await fetch("/health", { cache: "no-store" });
      if (!response.ok) {
        this.beginReconnect("Server unreachable");
        return;
      }

      const status = (await response.json()) as { startedAt?: string };
      if (!status.startedAt) {
        this.beginReconnect("Server unreachable");
        return;
      }

      if (this.serverStartedAt && status.startedAt !== this.serverStartedAt) {
        this.beginReconnect("Server restarted");
        return;
      }

      this.serverStartedAt = status.startedAt;
    } catch {
      this.beginReconnect("Server unreachable");
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
    this.roomId = msg.roomId;
    this.roomName = msg.roomName;
    this.levelId = msg.levelId;
    this.lastSnapshotTick = msg.tick;
    this.lastSnapshotReceivedAt = performance.now();
    this.isHost = msg.isHost;
    this.renderer.setLocalPlayer(msg.id);
    // Clean up any stale remote state from a previous connection.
    for (const id of this.remoteVisualStates.keys()) {
      this.renderer.removePlayer(id);
    }
    this.remoteVisualStates.clear();
    this.snapshots = [];
    this.updateRoomSettingsUI();
    console.log("Local id", msg.id, "room", msg.roomId);
  }

  updateRoomSettingsUI() {
    const roomSettings = document.getElementById("room-settings") as HTMLDivElement | null;
    if (roomSettings) roomSettings.hidden = !this.isHost;
    const roomNameInput = document.getElementById("room-name-input") as HTMLInputElement | null;
    if (roomNameInput) roomNameInput.value = this.roomName;
  }

  sendRoomUpdate(name?: string, password?: string, maxPlayers?: number) {
    if (!this.isHost) return;
    this.send({ type: "room_update", name, password, maxPlayers });
  }

  requestRespawn() {
    if (!this.localState.dead) return;
    this.send({ type: "respawn" });
  }

  beginReconnect(reason: string) {
    if (this.reconnecting || this.stopped) return;
    this.reconnecting = true;
    this.input.frozen = true;
    if (document.pointerLockElement) document.exitPointerLock();
    this.reconnectDeadline = performance.now() + 30000;
    this.reconnectAttemptCount = 0;
    this.reconnectMessage.textContent = `${reason}. Trying to reconnect...`;
    this.reconnectOverlay.hidden = false;
    this.reconnectProgressBar.style.animation = "none";
    // force reflow
    void this.reconnectProgressBar.offsetWidth;
    this.reconnectProgressBar.style.animation = "reconnect-shrink 30s linear forwards";
    this.attemptReconnect();
    this.reconnectTimer = window.setInterval(() => {
      if (performance.now() >= this.reconnectDeadline) {
        this.failReconnect("Could not reconnect");
        return;
      }
      this.attemptReconnect();
    }, 5000);
  }

  attemptReconnect() {
    if (!this.reconnecting || this.stopped) return;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)
    ) {
      return;
    }
    this.reconnectAttemptCount++;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams();
    params.set("name", this.playerName);
    params.set("room", this.roomId);
    params.set("password", this.roomPassword);

    const ws = new WebSocket(`${proto}//${window.location.host}?${params.toString()}`);
    ws.onmessage = (event) => {
      if (!this.reconnecting) return;
      const msg = JSON.parse(event.data) as ServerMsg;
      if (msg.type === "welcome") {
        this.ws = ws;
        this.acceptWelcome(msg);
        this.ws.onmessage = (ev) => this.onMessage(ev.data);
        this.ws.onclose = (ev) => this.onClose(ev);
        this.endReconnect();
      } else if (msg.type === "error") {
        ws.close();
      }
    };
    ws.onclose = () => {
      // Retry handled by interval.
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
  }

  endReconnect() {
    if (!this.reconnecting) return;
    this.reconnecting = false;
    this.input.frozen = false;
    this.reconnectOverlay.hidden = true;
    window.clearInterval(this.reconnectTimer);
    this.reconnectTimer = 0;
  }

  failReconnect(reason: string) {
    if (this.stopped) return;
    this.stop();
    this.reconnecting = false;
    this.input.frozen = false;
    this.reconnectOverlay.hidden = true;
    window.clearInterval(this.reconnectTimer);
    this.reconnectTimer = 0;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    this.ws = null;
    this.onDisconnect(reason);
  }

  onDeathEvent(victimId: string, killerId: string, weaponId: string) {
    if (victimId === this.localId) {
      this.lastKillerName =
        killerId === this.localId
          ? this.playerName
          : (this.remoteVisualStates.get(killerId)?.name ?? "Unknown");
      this.lastKillerWeapon = getWeapon(weaponId).name;
    }
    if (killerId === this.localId && victimId !== this.localId) {
      this.audio.playKillConfirm();
    }
  }

  openChat() {
    if (!this.localId || this.localState.dead) return;
    this.input.chatActive = true;
    this.chatContainer.classList.add("active");
    this.chatInput.value = "";
    this.chatInput.focus();
  }

  closeChat() {
    this.input.chatActive = false;
    this.chatContainer.classList.remove("active");
    this.chatInput.value = "";
  }

  submitChat() {
    const text = this.chatInput.value.trim();
    if (text) {
      this.send({ type: "chat", text });
    }
    this.closeChat();
  }

  addRoomEvent(text: string) {
    const line = document.createElement("div");
    line.className = "event-line";
    line.textContent = text;
    this.eventFeed.prepend(line);
    while (this.eventFeed.childElementCount > 7) {
      this.eventFeed.lastElementChild?.remove();
    }
    setTimeout(() => line.remove(), 9000);
  }

  spawnDamageNumber(pos: Vec3, damage: number, crit = false) {
    this.renderer.spawnDamageNumber(pos, damage, crit);
  }

  updateInteractHint(state: PlayerState) {
    if (
      this.levelId !== "training" ||
      !this.localId ||
      state.dead ||
      this.reconnecting ||
      this.input.chatActive
    ) {
      this.canInteractFlag = false;
      this.interactHint.classList.remove("active");
      return;
    }
    const eye = eyePosition(state);
    const dir = lookDirection(state);
    const look = this.renderer.checkBalloonButtonLook(eye, dir);
    this.canInteractFlag = look.hit;
    this.interactHint.textContent = look.hit ? "Press F to release balloons" : "";
    this.interactHint.classList.toggle("active", look.hit);
  }

  canInteract(): boolean {
    return this.canInteractFlag;
  }

  interact() {
    if (!this.canInteractFlag) return;
    this.send({ type: "spawn_balloons" });
  }

  estimatedServerTick() {
    const elapsedMs = performance.now() - this.lastSnapshotReceivedAt;
    return this.lastSnapshotTick + elapsedMs / TICK_DT;
  }

  onMessage(data: string) {
    const msg = JSON.parse(data) as ServerMsg;
    if (msg.type === "welcome") {
      this.acceptWelcome(msg);
    } else if (msg.type === "snapshot") {
      this.snapshots.push({ snapshot: msg.snapshot, receivedAt: performance.now() });
      if (this.snapshots.length > MAX_SNAPSHOT_HISTORY) this.snapshots.shift();
      this.lastSnapshotTick = msg.snapshot.tick;
      this.lastSnapshotReceivedAt = performance.now();
      this.renderer.updatePickups(msg.snapshot.pickups);
      this.renderer.updateBalloons(msg.snapshot.balloons);
      this.applyAuthoritativeNonMovementState(msg.snapshot);
      this.updateScoreboard(msg.snapshot);
    } else if (msg.type === "fire") {
      this.onFireEvent(msg.event);
    } else if (msg.type === "hit") {
      if (msg.victimId === this.localId) {
        this.localState.hp = msg.hp;
        this.damageFlashUntil = performance.now() + 130;
        this.audio.playHit();
      }
      if (msg.shooterId === this.localId && msg.victimId !== this.localId) {
        this.audio.playHitMarker();
        if (msg.pos) {
          this.renderer.addHitParticles(msg.pos);
          this.spawnDamageNumber(msg.pos, msg.damage, msg.crit);
        }
      }
      this.renderer.flashPlayer(msg.victimId);
    } else if (msg.type === "pong") {
      this.ping = (performance.now() - msg.clientTime) * 0.5;
    } else if (msg.type === "room_info") {
      this.roomName = msg.name;
      this.levelId = msg.levelId;
      this.isHost = msg.hostId === this.localId;
      this.updateRoomSettingsUI();
    } else if (msg.type === "pickup") {
      this.pickupToast.textContent = `Picked up ${msg.label}`;
      this.pickupToastUntil = performance.now() + 1800;
    } else if (msg.type === "death") {
      this.onDeathEvent(msg.victimId, msg.killerId, msg.weaponId);
    } else if (msg.type === "room_event") {
      this.addRoomEvent(msg.text);
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

    this.audio.playShoot(ev.weaponId);
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
      this.localState.spreadAccumMs = 0;
      this.localState.reloadEndTick = 0;
      this.localReloadEndMs = 0;
    }
    const weapon = getWeapon(this.localState.weaponId);
    const reloadDurationTicks = Math.max(1, Math.ceil((weapon.reloadMs / 1000) * TICK_RATE));

    if (this.localState.reloadEndTick > 0 && input.seq >= this.localState.reloadEndTick) {
      this.localState.ammo = weapon.maxAmmo;
      this.localState.reloadEndTick = 0;
      this.localReloadEndMs = 0;
    }
    if (
      input.reload &&
      this.localState.reloadEndTick === 0 &&
      this.localState.ammo < weapon.maxAmmo
    ) {
      this.localState.reloadEndTick = input.seq + reloadDurationTicks;
      this.localReloadEndMs = performance.now() + weapon.reloadMs;
      this.audio.playReload(weapon.id);
    }

    applyInput(this.localState, input);
    const jumpPadSeqBefore = this.localState.jumpPadSeq;
    stepPlayer(this.localState, TICK_DT / 1000, this.level);
    if (this.localState.jumpPadSeq > jumpPadSeqBefore) {
      this.audio.playJumpPad();
      this.lastJumpPadSeq = this.localState.jumpPadSeq;
    }

    if (
      input.fire &&
      !this.localState.dead &&
      this.localState.ammo > 0 &&
      this.localState.reloadEndTick === 0
    ) {
      const cooldownTicks = Math.max(1, Math.ceil((weapon.cooldownMs / 1000) * TICK_RATE));
      if (input.seq - this.localLastFireSeq >= cooldownTicks) {
        this.localLastFireSeq = input.seq;
        this.localState.ammo--;
        this.audio.playShoot(weapon.id);
        const spread = currentSpreadForPlayer(
          this.localState,
          weapon,
          this.localState.spreadAccumMs,
        );
        const minSpread = Math.min(
          weapon.spreadStanding ?? 0,
          weapon.spreadMoving ?? weapon.spread ?? 0,
        );
        const maxSpread = weapon.spreadMax ?? spread;
        const spreadRange = Math.max(0.0001, maxSpread - minSpread);
        const spreadRatio = Math.max(0, Math.min(1, (spread - minSpread) / spreadRange));
        const recoilScale = 1 + spreadRatio * 0.35;
        const stanceScale =
          (this.localState.grounded ? 1 : (weapon.recoilAirborneMultiplier ?? 1.25)) *
          (this.localState.crouching ? (weapon.recoilCrouchMultiplier ?? 0.85) : 1);
        const totalRecoilScale = recoilScale * stanceScale;
        const aimPitchKick = (weapon.aimRecoilPitch ?? 0) * totalRecoilScale;
        const aimYawKick = (Math.random() * 2 - 1) * (weapon.aimRecoilYaw ?? 0) * totalRecoilScale;
        const visualPitchKick = (weapon.visualRecoilPitch ?? 0) * totalRecoilScale;
        const visualYawKick =
          (Math.random() * 2 - 1) * (weapon.visualRecoilYaw ?? 0) * totalRecoilScale;
        const visualRollKick =
          ((Math.random() * 2 - 1) * (weapon.visualRecoilRoll ?? 0) + visualYawKick * 0.6) *
          totalRecoilScale;
        this.input.addRecoil(aimPitchKick, aimYawKick);
        this.localState.pitch = this.input.pitch;
        this.localState.yaw = this.input.yaw;
        this.recoilPitch += visualPitchKick;
        this.recoilYaw += visualYawKick;
        this.recoilRoll += visualRollKick;
        const pellets = weapon.pelletCount ?? 1;
        for (let i = 0; i < pellets; i++) {
          const origin = muzzlePosition(this.localState, spread);
          const dir = applySpread(lookDirection(this.localState), spread);
          const end = pointOnRay(origin, dir, SETTINGS.combat.fireMaxDistance);
          this.renderer.addTracer(origin, end);
        }
      }
    }

    this.localState.spreadAccumMs = updateSpreadAccum(
      weapon,
      this.localState.spreadAccumMs,
      TICK_DT,
      input.fire,
    );
  }

  tickLocalSimulation() {
    if (!this.localId || this.localState.dead || this.reconnecting) return;

    const wasGrounded = this.localState.grounded;
    this.previousLocalState = clonePlayerState(this.localState);
    this.inputSeq++;

    const input = this.input.sample(this.inputSeq);
    if (input.jump && wasGrounded) this.audio.playJump();
    this.pendingFire ||= input.fire;
    this.pendingReload ||= input.reload;
    this.applyInputPrediction(input);

    const horizontalSpeed = Math.hypot(this.localState.vel.x, this.localState.vel.z);
    const stepUp = this.localState.pos.y - this.previousLocalState.pos.y;
    if (
      this.localState.grounded &&
      stepUp > 0.05 &&
      stepUp <= SETTINGS.player.maxStepHeight + 0.05 &&
      horizontalSpeed > 0.25
    ) {
      this.localVisualStepOffsetY = Math.max(this.localVisualStepOffsetY - stepUp, -0.8);
    } else if (stepUp < -0.2) {
      this.localVisualStepOffsetY = 0;
    }
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
          (this.localState.pos.y - this.previousLocalState.pos.y) * alpha +
          this.localVisualStepOffsetY,
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
    this.damageFlash.classList.toggle("active", performance.now() < this.damageFlashUntil);
    const remainingMs = Math.max(
      0,
      (this.localState.respawnTick - this.estimatedServerTick()) * TICK_DT,
    );
    const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    this.deathScreen.hidden = !p.dead;
    if (p.dead) {
      const killerLine = this.lastKillerName
        ? `Killed by ${this.lastKillerName} (${this.lastKillerWeapon})`
        : "You died";
      this.deathMessage.innerHTML = `${killerLine}<br>${remainingSeconds} second${
        remainingSeconds === 1 ? "" : "s"
      } until auto respawn.`;
    } else {
      this.deathMessage.textContent = "Respawn when you're ready.";
      this.lastKillerName = "";
      this.lastKillerWeapon = "";
    }
    this.respawnButton.textContent = p.dead
      ? `Respawn Now (${remainingSeconds}s auto)`
      : "Respawn Now";

    const scoped = !p.dead && this.input.aiming && getWeapon(p.weaponId).id === "sniper";
    this.sniperScope.classList.toggle("active", scoped);
  }

  updateScoreboard(snapshot: Snapshot) {
    if (!this.localId) return;
    const players = [...snapshot.players];
    const localIndex = players.findIndex((p) => p.id === this.localId);
    if (localIndex < 0) players.push(this.localState);
    players.sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths);

    this.scoreboardBody.innerHTML = "";
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const isLocal = p.id === this.localId;
      const row = document.createElement("tr");
      if (isLocal) row.classList.add("local");
      row.innerHTML = `
        <td>${i + 1}</td>
        <td>${p.name}</td>
        <td class="num">${p.kills}</td>
        <td class="num">${p.deaths}</td>
        <td class="num">${p.score}</td>
        <td class="num">${isLocal ? Math.round(this.ping) : "-"}</td>
      `;
      this.scoreboardBody.appendChild(row);
    }
  }

  renderLoop(now: number) {
    if (this.stopped) return;

    const renderDt = Math.min(100, now - this.lastRenderTime) / 1000;
    this.lastRenderTime = now;
    const weapon = getWeapon(this.localState.weaponId);
    const recoilRecoverMs = weapon.recoilRecoverMs ?? 160;
    const recoilDecay = Math.exp((-renderDt * 1000) / recoilRecoverMs);
    this.recoilPitch *= recoilDecay;
    this.recoilYaw *= recoilDecay;
    this.recoilRoll *= recoilDecay;
    this.localVisualStepOffsetY *= Math.exp(-renderDt * 18);
    if (Math.abs(this.localVisualStepOffsetY) < 0.001) {
      this.localVisualStepOffsetY = 0;
    }

    const renderedLocalState = this.getRenderedLocalState(now);
    const renderedWeapon = getWeapon(renderedLocalState.weaponId);
    const cameraAimFov = this.input.aimFov(renderedWeapon);
    this.renderer.setCameraFromPlayer(
      renderedLocalState,
      renderDt,
      this.settings.headSway,
      this.input.lean,
      this.input.aiming,
      cameraAimFov,
      this.recoilPitch,
      this.recoilYaw,
      this.recoilRoll,
    );
    this.renderer.updatePlayer(renderedLocalState, true);
    const reloadProgress =
      this.localReloadEndMs > 0
        ? Math.min(1, Math.max(0, 1 - (this.localReloadEndMs - now) / renderedWeapon.reloadMs))
        : 0;
    this.renderer.updateFirstPersonWeapon(
      renderedLocalState,
      renderDt,
      this.input.aiming,
      reloadProgress,
      this.recoilPitch,
      this.recoilYaw,
      this.recoilRoll,
    );
    this.updateRemotePlayers(renderDt);
    this.renderer.updateMovingPlatforms(now);
    this.renderer.updateTracers(renderDt);
    this.renderer.updateHitParticles(renderDt);
    this.renderer.updateDamageNumbers(renderDt);
    this.updateInteractHint(renderedLocalState);
    this.updatePadHum(renderedLocalState);
    this.updateHUD();
    this.renderer.render();

    if (!this.stopped) requestAnimationFrame((time) => this.renderLoop(time));
  }

  updatePadHum(state: PlayerState) {
    let strongest = 0;
    for (const pad of this.level.jumpPads) {
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
const nameInput = document.getElementById("player-name") as HTMLInputElement;
const nameError = document.getElementById("name-error") as HTMLDivElement;
const loadingStatus = document.getElementById("loading-status") as HTMLDivElement;
const loadingTip = document.getElementById("loading-tip") as HTMLDivElement;
const tabCreate = document.getElementById("tab-create") as HTMLButtonElement;
const tabJoin = document.getElementById("tab-join") as HTMLButtonElement;
const createPanel = document.getElementById("create-panel") as HTMLDivElement;
const joinPanel = document.getElementById("join-panel") as HTMLDivElement;
const createRoomName = document.getElementById("create-room-name") as HTMLInputElement;
const autoRoomName = document.getElementById("auto-room-name") as HTMLSpanElement;
const createRoomPassword = document.getElementById("create-room-password") as HTMLInputElement;
const createRoomLevel = document.getElementById("create-room-level") as HTMLSelectElement;
const createRoomMax = document.getElementById("create-room-max") as HTMLSelectElement;
const createRoomButton = document.getElementById("create-room-button") as HTMLButtonElement;
const joinRoomPassword = document.getElementById("join-room-password") as HTMLInputElement;
const roomList = document.getElementById("room-list") as HTMLDivElement;
const joinRoomButton = document.getElementById("join-room-button") as HTMLButtonElement;
const pauseMenu = document.getElementById("pause-menu") as HTMLDivElement;
const optionsButton = document.getElementById("options-button") as HTMLButtonElement;
const resumeButton = document.getElementById("resume-button") as HTMLButtonElement;
const exitRoomButton = document.getElementById("exit-room-button") as HTMLButtonElement;
const headSwayToggle = document.getElementById("head-sway-toggle") as HTMLInputElement;
const masterVolumeSlider = document.getElementById("master-volume-slider") as HTMLInputElement;
const musicToggle = document.getElementById("music-toggle") as HTMLInputElement;
const musicVolumeSlider = document.getElementById("music-volume-slider") as HTMLInputElement;
const sfxToggle = document.getElementById("sfx-toggle") as HTMLInputElement;
const sfxVolumeSlider = document.getElementById("sfx-volume-slider") as HTMLInputElement;
const shadowsToggle = document.getElementById("shadows-toggle") as HTMLInputElement;
const brightnessSlider = document.getElementById("brightness-slider") as HTMLInputElement;
const brightnessValue = document.getElementById("brightness-value") as HTMLSpanElement;
const roomNameInput = document.getElementById("room-name-input") as HTMLInputElement;
const roomPasswordInput = document.getElementById("room-password-input") as HTMLInputElement;
const roomMaxInput = document.getElementById("room-max-input") as HTMLSelectElement;
const applyRoomSettingsButton = document.getElementById("apply-room-settings") as HTMLButtonElement;

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
createRoomLevel.innerHTML = LEVELS.map(
  (level) => `<option value="${level.id}">${level.name}</option>`,
).join("");
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
  if (!titleScreen.hidden) return;
  if (activeClient?.reconnecting) {
    event.preventDefault();
    return;
  }
  if (activeClient?.chatContainer.classList.contains("active")) {
    if (event.code === "Escape") {
      event.preventDefault();
      activeClient.closeChat();
    }
    return;
  }
  if (event.code === "Space" && activeClient?.localState.dead) {
    event.preventDefault();
    event.stopImmediatePropagation();
    activeClient.requestRespawn();
    return;
  }
  if (event.code === "KeyT" && activeClient) {
    event.preventDefault();
    activeClient.openChat();
    return;
  }
  if (event.code === "KeyF" && activeClient && activeClient.canInteract()) {
    event.preventDefault();
    activeClient.interact();
    return;
  }
  if (event.code === "Escape") {
    event.preventDefault();
    setPauseMenuVisible(pauseMenu.hidden === true);
  } else if (event.code === "KeyP") {
    event.preventDefault();
    if (!event.repeat && activeClient) {
      activeClient.scoreboard.hidden = false;
    }
  }
});

window.addEventListener("keyup", (event) => {
  if (event.code === "KeyP" && activeClient) {
    activeClient.scoreboard.hidden = true;
  }
});

resumeButton.addEventListener("click", () => setPauseMenuVisible(false));
exitRoomButton.addEventListener("click", () => {
  activeClient?.disconnect();
  activeClient = null;
  setPauseMenuVisible(false);
  titleScreen.hidden = false;
  createRoomButton.disabled = false;
  joinRoomButton.disabled = selectedRoomId === "";
  clearLoading();
  void fetchRoomList();
});
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

interface JoinOptions {
  roomId?: string;
  roomName?: string;
  levelId?: string;
  password?: string;
  maxPlayers?: number;
}

function connectForJoin(
  playerName: string,
  options: JoinOptions = {},
): Promise<{ ws: WebSocket; welcome: Extract<ServerMsg, { type: "welcome" }> }> {
  return new Promise((resolve, reject) => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams();
    params.set("name", playerName);
    if (options.roomId) params.set("room", options.roomId);
    if (options.roomName) params.set("roomName", options.roomName);
    if (options.levelId) params.set("levelId", options.levelId);
    if (options.password) params.set("password", options.password);
    if (options.maxPlayers) params.set("maxPlayers", String(options.maxPlayers));

    const ws = new WebSocket(`${proto}//${window.location.host}?${params.toString()}`);

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data) as ServerMsg;
      if (msg.type === "welcome") {
        resolve({ ws, welcome: msg });
      } else if (msg.type === "error") {
        reject(new Error(msg.message));
      }
    };
    ws.onclose = (event) => reject(new Error(event.reason || "Could not join match"));
    ws.onerror = () => reject(new Error("Could not connect to server"));
  });
}

async function doJoin(options: JoinOptions) {
  const playerName = nameInput.value.trim().slice(0, 24) || "Player";
  nameError.textContent = "";
  createRoomButton.disabled = true;
  joinRoomButton.disabled = true;
  setLoading("Dialing arena uplink...");
  localStorage.setItem("playerName", playerName);

  try {
    const { ws, welcome } = await connectForJoin(playerName, options);
    setLoading("Loading arena assets...");
    const client = new GameClient(playerName, ws, welcome, settings, (reason) => {
      activeClient = null;
      titleScreen.hidden = false;
      nameError.textContent = reason;
      createRoomButton.disabled = false;
      joinRoomButton.disabled = selectedRoomId === "";
      clearLoading();
      nameInput.focus();
      void fetchRoomList();
    });
    await client.ready;
    client.roomPassword = options.password ?? "";
    activeClient = client;
    clearLoading();
    titleScreen.hidden = true;
    client.start();
  } catch (err) {
    titleScreen.hidden = false;
    nameError.textContent = err instanceof Error ? err.message : "Could not join match";
    createRoomButton.disabled = false;
    joinRoomButton.disabled = selectedRoomId === "";
    clearLoading();
    nameInput.focus();
  }
}

let selectedRoomId = "";

async function fetchRoomList() {
  if (titleScreen.hidden) return;
  try {
    const res = await fetch("/rooms", { cache: "no-store" });
    if (!res.ok) return;
    const list = (await res.json()) as {
      id: string;
      name: string;
      levelId: string;
      levelName: string;
      playerCount: number;
      maxPlayers: number;
      hasPassword: boolean;
    }[];
    renderRoomList(list);
  } catch {
    // ignore
  }
}

function renderRoomList(
  list: {
    id: string;
    name: string;
    levelId: string;
    levelName: string;
    playerCount: number;
    maxPlayers: number;
    hasPassword: boolean;
  }[],
) {
  roomList.innerHTML = "";
  for (const room of list) {
    const item = document.createElement("div");
    item.className = "room-item";
    if (room.id === selectedRoomId) item.classList.add("selected");
    const shortId = room.id.slice(0, 6);
    item.innerHTML = `
      <div>
        <strong>${room.name}</strong>
        <span style="opacity:0.5;font-size:11px;margin-left:6px;">#${shortId}</span>
        <div style="font-size:11px;color:#94a3b8;">${room.levelName} • ${room.playerCount}/${room.maxPlayers} players</div>
      </div>
      <div>${room.hasPassword ? '<span class="room-item-locked">LOCKED</span>' : ""}</div>
    `;
    item.addEventListener("click", () => {
      selectedRoomId = room.id;
      joinRoomButton.disabled = false;
      renderRoomList(list);
    });
    roomList.appendChild(item);
  }
}

tabCreate.addEventListener("click", () => {
  tabCreate.classList.add("active");
  tabJoin.classList.remove("active");
  createPanel.hidden = false;
  joinPanel.hidden = true;
});

tabJoin.addEventListener("click", () => {
  tabJoin.classList.add("active");
  tabCreate.classList.remove("active");
  createPanel.hidden = true;
  joinPanel.hidden = false;
  void fetchRoomList();
});

function generateRoomName(): string {
  const prefixes = [
    "Neon",
    "Turbo",
    "Cyber",
    "Iron",
    "Solar",
    "Shadow",
    "Rapid",
    "Mega",
    "Hyper",
    "Quantum",
  ];
  const suffixes = [
    "Arena",
    "Zone",
    "Pit",
    "Dome",
    "Hangar",
    "Base",
    "Vault",
    "Foundry",
    "Station",
    "Colony",
  ];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const suffix = suffixes[Math.floor(Math.random() * suffixes.length)];
  const num = Math.floor(Math.random() * 99) + 1;
  return `${prefix} ${suffix} ${num}`;
}

createRoomButton.addEventListener("click", () => {
  void doJoin({
    roomName: createRoomName.value,
    levelId: createRoomLevel.value,
    password: createRoomPassword.value,
    maxPlayers: Number(createRoomMax.value),
  });
});

autoRoomName.addEventListener("click", () => {
  createRoomName.value = generateRoomName();
});

joinRoomButton.addEventListener("click", () => {
  if (!selectedRoomId) return;
  void doJoin({ roomId: selectedRoomId, password: joinRoomPassword.value });
});

applyRoomSettingsButton.addEventListener("click", () => {
  activeClient?.sendRoomUpdate(
    roomNameInput.value,
    roomPasswordInput.value,
    Number(roomMaxInput.value),
  );
});

setInterval(() => {
  if (!joinPanel.hidden && !titleScreen.hidden) {
    void fetchRoomList();
  }
}, 3000);

void fetchRoomList();
