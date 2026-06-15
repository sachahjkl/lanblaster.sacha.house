import {
  clonePlayerState,
  cloneVec3,
  GRAVITY,
  GROUND_FRICTION,
  AIR_FRICTION,
  JUMP_SPEED,
  PLAYER_CROUCH_HEIGHT,
  PlayerInput,
  PlayerState,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  Vec3,
  getWeapon,
  WEAPONS,
  movingPlatformPosition,
} from "./protocol.ts";
import { DEFAULT_LEVEL_ID, LevelDefinition, getLevelData } from "./mapData.ts";
import { SETTINGS } from "./settings.ts";

const LEVEL_COLLIDER_MARGIN = 1.5;
const LEVEL_WALL_HEIGHT = 24;

interface DerivedLevelData {
  colliders: { min: Vec3; max: Vec3; color?: number }[];
  fallOutY: number;
}

const derivedLevelCache = new Map<string, DerivedLevelData>();

function resolveLevel(level?: LevelDefinition): LevelDefinition {
  return level ?? getLevelData(DEFAULT_LEVEL_ID);
}

function getDerivedLevelData(level?: LevelDefinition): DerivedLevelData {
  const resolvedLevel = resolveLevel(level);
  const cached = derivedLevelCache.get(resolvedLevel.id);
  if (cached) return cached;

  const bounds = resolvedLevel.boxes.reduce(
    (next, box) => ({
      min: {
        x: Math.min(next.min.x, box.min.x),
        y: Math.min(next.min.y, box.min.y),
        z: Math.min(next.min.z, box.min.z),
      },
      max: {
        x: Math.max(next.max.x, box.max.x),
        y: Math.max(next.max.y, box.max.y),
        z: Math.max(next.max.z, box.max.z),
      },
    }),
    {
      min: { x: Infinity, y: Infinity, z: Infinity },
      max: { x: -Infinity, y: -Infinity, z: -Infinity },
    },
  );

  const guardColliders = [
    {
      min: {
        x: bounds.min.x - LEVEL_COLLIDER_MARGIN,
        y: bounds.min.y - 1,
        z: bounds.min.z - LEVEL_COLLIDER_MARGIN,
      },
      max: {
        x: bounds.max.x + LEVEL_COLLIDER_MARGIN,
        y: bounds.min.y,
        z: bounds.max.z + LEVEL_COLLIDER_MARGIN,
      },
    },
    {
      min: {
        x: bounds.min.x - LEVEL_COLLIDER_MARGIN,
        y: bounds.min.y,
        z: bounds.min.z - LEVEL_COLLIDER_MARGIN,
      },
      max: {
        x: bounds.min.x,
        y: bounds.max.y + LEVEL_WALL_HEIGHT,
        z: bounds.max.z + LEVEL_COLLIDER_MARGIN,
      },
    },
    {
      min: {
        x: bounds.max.x,
        y: bounds.min.y,
        z: bounds.min.z - LEVEL_COLLIDER_MARGIN,
      },
      max: {
        x: bounds.max.x + LEVEL_COLLIDER_MARGIN,
        y: bounds.max.y + LEVEL_WALL_HEIGHT,
        z: bounds.max.z + LEVEL_COLLIDER_MARGIN,
      },
    },
    {
      min: {
        x: bounds.min.x,
        y: bounds.min.y,
        z: bounds.min.z - LEVEL_COLLIDER_MARGIN,
      },
      max: {
        x: bounds.max.x,
        y: bounds.max.y + LEVEL_WALL_HEIGHT,
        z: bounds.min.z,
      },
    },
    {
      min: {
        x: bounds.min.x,
        y: bounds.min.y,
        z: bounds.max.z,
      },
      max: {
        x: bounds.max.x,
        y: bounds.max.y + LEVEL_WALL_HEIGHT,
        z: bounds.max.z + LEVEL_COLLIDER_MARGIN,
      },
    },
  ];

  const derived = {
    colliders: [...resolvedLevel.boxes, ...guardColliders],
    fallOutY: bounds.min.y - 8,
  };
  derivedLevelCache.set(resolvedLevel.id, derived);
  return derived;
}

export function createPlayer(id: string, level?: LevelDefinition, spawnIndex = 0): PlayerState {
  const resolvedLevel = resolveLevel(level);
  const spawn = resolvedLevel.spawnPoints[spawnIndex % resolvedLevel.spawnPoints.length];
  const weapon = WEAPONS[0];
  return {
    id,
    name: "Player",
    pos: cloneVec3(spawn),
    vel: { x: 0, y: 0, z: 0 },
    platformVel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    grounded: false,
    crouching: false,
    aiming: false,
    jumpPadSeq: 0,
    hp: 100,
    maxHp: 100,
    dead: false,
    respawnTick: 0,
    weaponId: weapon.id,
    ammo: weapon.maxAmmo,
    lastFireTick: -9999,
    reloadEndTick: 0,
    spreadAccumMs: 0,
    lastSpreadUpdateTick: 0,
    kills: 0,
    deaths: 0,
    score: 0,
    lastProcessedInputSeq: 0,
  };
}

export function resetPlayer(p: PlayerState, level?: LevelDefinition, spawnIndex = 0): void {
  const resolvedLevel = resolveLevel(level);
  const spawn = resolvedLevel.spawnPoints[spawnIndex % resolvedLevel.spawnPoints.length];
  const weapon = WEAPONS[0];
  p.pos = cloneVec3(spawn);
  p.vel = { x: 0, y: 0, z: 0 };
  p.platformVel = { x: 0, y: 0, z: 0 };
  p.yaw = 0;
  p.pitch = 0;
  p.grounded = false;
  p.crouching = false;
  p.aiming = false;
  p.jumpPadSeq = 0;
  p.hp = 100;
  p.dead = false;
  p.respawnTick = 0;
  p.weaponId = weapon.id;
  p.ammo = weapon.maxAmmo;
  p.lastFireTick = -9999;
  p.reloadEndTick = 0;
  p.spreadAccumMs = 0;
  p.lastSpreadUpdateTick = 0;
  p.kills = 0;
  p.deaths = 0;
  p.score = 0;
  p.lastProcessedInputSeq = 0;
}

export function eyePosition(p: PlayerState): Vec3 {
  const height = p.crouching ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT;
  return { x: p.pos.x, y: p.pos.y + height * 0.85, z: p.pos.z };
}

export function lookDirection(p: PlayerState): Vec3 {
  const cy = Math.cos(p.yaw);
  const sy = Math.sin(p.yaw);
  const cp = Math.cos(p.pitch);
  const sp = Math.sin(p.pitch);
  // yaw=0 looks down -Z (standard FPS / Three.js convention)
  return { x: sy * cp, y: sp, z: -cy * cp };
}

export function pointOnRay(origin: Vec3, dir: Vec3, t: number): Vec3 {
  return {
    x: origin.x + dir.x * t,
    y: origin.y + dir.y * t,
    z: origin.z + dir.z * t,
  };
}

export function directionTo(from: Vec3, to: Vec3): Vec3 {
  const x = to.x - from.x;
  const y = to.y - from.y;
  const z = to.z - from.z;
  const len = Math.max(0.0001, Math.sqrt(x * x + y * y + z * z));
  return { x: x / len, y: y / len, z: z / len };
}

function normalize(v: Vec3): Vec3 {
  const len = Math.max(0.0001, Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z));
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function applySpread(baseDir: Vec3, spread: number): Vec3 {
  if (spread <= 0) return baseDir;
  const r = Math.sqrt(Math.random()) * spread;
  const theta = Math.random() * Math.PI * 2;

  const arbitrary = Math.abs(baseDir.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const right = normalize(cross(arbitrary, baseDir));
  const up = normalize(cross(baseDir, right));

  return normalize({
    x: baseDir.x + (right.x * Math.cos(theta) + up.x * Math.sin(theta)) * r,
    y: baseDir.y + (right.y * Math.cos(theta) + up.y * Math.sin(theta)) * r,
    z: baseDir.z + (right.z * Math.cos(theta) + up.z * Math.sin(theta)) * r,
  });
}

export function muzzlePosition(p: PlayerState, spread = 0): Vec3 {
  const cy = Math.cos(p.yaw);
  const sy = Math.sin(p.yaw);
  const yawForward = { x: sy, z: -cy };
  const yawRight = normalize({ x: cy, y: 0, z: sy });
  const dir = lookDirection(p);
  const weapon = getWeapon(p.weaponId);
  const weaponVisuals = SETTINGS.weaponVisuals;
  const muzzleOffset = weapon.muzzleOffset ?? { x: 0, y: 0.028, z: -0.195 };
  const up = normalize(cross(yawRight, dir));

  const center = {
    x:
      p.pos.x +
      yawForward.x * weaponVisuals.forwardHandOffset +
      yawRight.x * weaponVisuals.rightHandOffset,
    y: p.pos.y + weaponVisuals.handHeight,
    z:
      p.pos.z +
      yawForward.z * weaponVisuals.forwardHandOffset +
      yawRight.z * weaponVisuals.rightHandOffset,
  };
  if (p.aiming) {
    center.x = p.pos.x + yawForward.x * (weaponVisuals.forwardHandOffset + 0.04);
    center.y = p.pos.y + weaponVisuals.handHeight + 0.1;
    center.z = p.pos.z + yawForward.z * (weaponVisuals.forwardHandOffset + 0.04);
  }

  const pos = {
    x: center.x + yawRight.x * muzzleOffset.x + up.x * muzzleOffset.y - dir.x * muzzleOffset.z,
    y: center.y + up.y * muzzleOffset.y - dir.y * muzzleOffset.z,
    z: center.z + yawRight.z * muzzleOffset.x + up.z * muzzleOffset.y - dir.z * muzzleOffset.z,
  };
  if (spread <= 0) return pos;
  const jitter = spread * 0.03;
  return {
    x: pos.x + (Math.random() - 0.5) * jitter,
    y: pos.y + (Math.random() - 0.5) * jitter,
    z: pos.z + (Math.random() - 0.5) * jitter,
  };
}

export function currentSpread(weapon: (typeof WEAPONS)[number], accumMs: number): number {
  return currentSpreadForPlayer(
    { vel: { x: 0, y: 0, z: 0 }, platformVel: { x: 0, y: 0, z: 0 } } as PlayerState,
    weapon,
    accumMs,
  );
}

function horizontalSpeed(p: PlayerState): number {
  return Math.hypot(p.vel.x + p.platformVel.x, p.vel.z + p.platformVel.z);
}

export function currentSpreadForPlayer(
  p: PlayerState,
  weapon: (typeof WEAPONS)[number],
  accumMs: number,
): number {
  const fallbackSpread = weapon.spread ?? 0;
  const stationaryMinSpread = weapon.spreadStanding ?? 0;
  const movingMinSpread = weapon.spreadMoving ?? fallbackSpread;
  const moveThreshold = weapon.spreadMoveThreshold ?? 0.75;
  const minSpread = horizontalSpeed(p) > moveThreshold ? movingMinSpread : stationaryMinSpread;
  const maxSpread = weapon.spreadMax ?? minSpread;
  const rampMs = weapon.spreadRampMs ?? 0;
  if (rampMs <= 0 || maxSpread <= minSpread) return minSpread;
  const t = Math.min(1, accumMs / rampMs);
  return minSpread + (maxSpread - minSpread) * t;
}

export function updateSpreadAccum(
  weapon: (typeof WEAPONS)[number],
  accumMs: number,
  dtMs: number,
  firing: boolean,
): number {
  const rampMs = weapon.spreadRampMs ?? 0;
  const recoveryMs = weapon.spreadRecoveryMs ?? 200;
  if (firing) {
    return Math.min(rampMs, accumMs + dtMs);
  }
  if (recoveryMs <= 0) return 0;
  const decay = dtMs * (rampMs / recoveryMs);
  return Math.max(0, accumMs - decay);
}

export function playerAABB(p: PlayerState): { min: Vec3; max: Vec3 } {
  const height = p.crouching ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT;
  return {
    min: { x: p.pos.x - PLAYER_RADIUS, y: p.pos.y, z: p.pos.z - PLAYER_RADIUS },
    max: { x: p.pos.x + PLAYER_RADIUS, y: p.pos.y + height, z: p.pos.z + PLAYER_RADIUS },
  };
}

function rayIntersectAABB(origin: Vec3, dir: Vec3, box: { min: Vec3; max: Vec3 }): number | null {
  let tmin = -Infinity;
  let tmax = Infinity;

  const axes: ("x" | "y" | "z")[] = ["x", "y", "z"];
  for (const axis of axes) {
    if (Math.abs(dir[axis]) < 1e-8) {
      if (origin[axis] < box.min[axis] || origin[axis] > box.max[axis]) {
        return null;
      }
    } else {
      const invD = 1 / dir[axis];
      let t1 = (box.min[axis] - origin[axis]) * invD;
      let t2 = (box.max[axis] - origin[axis]) * invD;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax || tmax < 0) return null;
    }
  }

  return tmin >= 0 ? tmin : tmax;
}

export function raycastLevel(
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  level?: LevelDefinition,
): number | null {
  let best: number | null = null;
  for (const box of getDerivedLevelData(level).colliders) {
    const t = rayIntersectAABB(origin, dir, box);
    if (t !== null && t <= maxDist && (best === null || t < best)) {
      best = t;
    }
  }
  return best;
}

function raycastCapsule(origin: Vec3, dir: Vec3, player: PlayerState): number | null {
  const r = PLAYER_RADIUS;
  const h = player.crouching ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT;
  const cy = player.pos.y + h * 0.5;
  const halfLen = Math.max(0, h * 0.5 - r);
  const a = { x: player.pos.x, y: cy - halfLen, z: player.pos.z };
  const b = { x: player.pos.x, y: cy + halfLen, z: player.pos.z };

  // Cylinder body (vertical axis)
  const ox = origin.x - player.pos.x;
  const oz = origin.z - player.pos.z;
  const A = dir.x * dir.x + dir.z * dir.z;

  let bestT: number | null = null;

  if (A > 1e-8) {
    const B = 2 * (ox * dir.x + oz * dir.z);
    const C = ox * ox + oz * oz - r * r;
    const disc = B * B - 4 * A * C;
    if (disc >= 0) {
      const t = (-B - Math.sqrt(disc)) / (2 * A);
      if (t >= 0) {
        const y = origin.y + dir.y * t;
        if (y >= a.y && y <= b.y) {
          bestT = t;
        }
      }
    }
  } else if (ox * ox + oz * oz <= r * r) {
    // Ray parallel to and inside cylinder; check slab.
    const t1 = (a.y - origin.y) / dir.y;
    const t2 = (b.y - origin.y) / dir.y;
    const tmin = Math.min(t1, t2);
    if (tmin >= 0) bestT = tmin;
  }

  // Spherical caps
  const raycastSphere = (center: Vec3): number | null => {
    const co = { x: origin.x - center.x, y: origin.y - center.y, z: origin.z - center.z };
    const b2 = dir.x * co.x + dir.y * co.y + dir.z * co.z;
    const c2 = co.x * co.x + co.y * co.y + co.z * co.z - r * r;
    const disc = b2 * b2 - c2;
    if (disc < 0) return null;
    const t = -b2 - Math.sqrt(disc);
    return t >= 0 ? t : null;
  };

  const bottom = raycastSphere(a);
  const top = raycastSphere(b);

  for (const t of [bottom, top]) {
    if (t !== null && (bestT === null || t < bestT)) {
      bestT = t;
    }
  }

  return bestT;
}

export function raycastPlayers(
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  excludeId: string,
  players: PlayerState[],
): { t: number; player: PlayerState } | null {
  let best: { t: number; player: PlayerState } | null = null;
  for (const player of players) {
    if (player.id === excludeId || player.dead) continue;
    const hit = raycastCapsule(origin, dir, player);
    if (hit !== null && hit <= maxDist && (!best || hit < best.t)) {
      best = { t: hit, player };
    }
  }
  return best;
}

export function raycastTrainingTarget(
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  target: { pos: Vec3; radius: number; normal: Vec3; ringDamage: number[] },
): { t: number; point: Vec3; ring: number } | null {
  const denom = dir.x * target.normal.x + dir.y * target.normal.y + dir.z * target.normal.z;
  if (Math.abs(denom) < 0.0001) return null;
  const oc = {
    x: target.pos.x - origin.x,
    y: target.pos.y - origin.y,
    z: target.pos.z - origin.z,
  };
  const t = (oc.x * target.normal.x + oc.y * target.normal.y + oc.z * target.normal.z) / denom;
  if (t < 0 || t > maxDist) return null;
  const point = pointOnRay(origin, dir, t);
  const dist = Math.hypot(point.x - target.pos.x, point.y - target.pos.y, point.z - target.pos.z);
  if (dist > target.radius) return null;
  const ringCount = target.ringDamage.length;
  const ringWidth = target.radius / ringCount;
  const ring = Math.min(ringCount - 1, Math.floor(dist / ringWidth));
  return { t, point, ring };
}

export function raycastBalloon(
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  balloon: { pos: Vec3; radius: number },
): { t: number; point: Vec3 } | null {
  const oc = {
    x: origin.x - balloon.pos.x,
    y: origin.y - balloon.pos.y,
    z: origin.z - balloon.pos.z,
  };
  const b = dir.x * oc.x + dir.y * oc.y + dir.z * oc.z;
  const c = oc.x * oc.x + oc.y * oc.y + oc.z * oc.z - balloon.radius * balloon.radius;
  const disc = b * b - c;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  if (t < 0 || t > maxDist) return null;
  return { t, point: pointOnRay(origin, dir, t) };
}

export function aimTargetPoint(
  p: PlayerState,
  maxDist: number,
  players: PlayerState[] = [],
  level?: LevelDefinition,
): Vec3 {
  const eye = eyePosition(p);
  const look = lookDirection(p);
  const levelHit = raycastLevel(eye, look, maxDist, level);
  const playerHit = raycastPlayers(eye, look, maxDist, p.id, players);

  let t = maxDist;
  if (levelHit !== null) t = Math.min(t, levelHit);
  if (playerHit !== null) t = Math.min(t, playerHit.t);

  return pointOnRay(eye, look, t);
}

function intersectAABB(a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }): boolean {
  return (
    a.min.x < b.max.x &&
    a.max.x > b.min.x &&
    a.min.y < b.max.y &&
    a.max.y > b.min.y &&
    a.min.z < b.max.z &&
    a.max.z > b.min.z
  );
}

function isOnLadder(p: PlayerState, level?: LevelDefinition): boolean {
  const box = playerAABB(p);
  return resolveLevel(level).ladders.some((ladder) => intersectAABB(box, ladder));
}

function clampToLadder(p: PlayerState, level?: LevelDefinition): void {
  const box = playerAABB(p);
  for (const ladder of resolveLevel(level).ladders) {
    if (!intersectAABB(box, ladder)) continue;
    p.pos.x = Math.max(
      ladder.min.x + PLAYER_RADIUS,
      Math.min(ladder.max.x - PLAYER_RADIUS, p.pos.x),
    );
    p.pos.z = Math.max(
      ladder.min.z + PLAYER_RADIUS,
      Math.min(ladder.max.z - PLAYER_RADIUS, p.pos.z),
    );
    return;
  }
}

/**
 * Apply input to a player state (changes velocity / orientation).
 * Called before the physics step.
 */
export function applyInput(p: PlayerState, input: PlayerInput): void {
  p.yaw = input.lookYaw;
  p.pitch = input.lookPitch;
  p.crouching = input.crouch;
  p.aiming = input.aiming;

  const cy = Math.cos(p.yaw);
  const sy = Math.sin(p.yaw);

  // forward = (sin(yaw), 0, -cos(yaw)), right = (cos(yaw), 0, sin(yaw))
  const wishDir: Vec3 = {
    x: input.forward * sy + input.right * cy,
    y: 0,
    z: -input.forward * cy + input.right * sy,
  };

  // Normalize only if moving
  const len = Math.sqrt(wishDir.x * wishDir.x + wishDir.z * wishDir.z);
  if (len > 0.001) {
    wishDir.x /= len;
    wishDir.z /= len;
  }

  const moveSpeed = PLAYER_SPEED * (p.crouching ? SETTINGS.player.crouchSpeedMultiplier : 1);
  const onLadder = isOnLadder(p);

  if (onLadder) {
    p.vel.x = wishDir.x * moveSpeed * 0.45;
    p.vel.z = wishDir.z * moveSpeed * 0.45;
    p.vel.y = input.forward * PLAYER_SPEED * 0.72;
    p.grounded = false;
    if (input.jump) {
      p.vel.y = JUMP_SPEED * 0.72;
      p.vel.x += Math.sin(p.yaw) * PLAYER_SPEED * 0.5;
      p.vel.z += -Math.cos(p.yaw) * PLAYER_SPEED * 0.5;
    }
    return;
  }

  if (p.grounded) {
    p.vel.x = wishDir.x * moveSpeed;
    p.vel.z = wishDir.z * moveSpeed;
    if (input.jump) {
      p.vel.y = JUMP_SPEED;
      p.vel.x += p.platformVel.x;
      p.vel.z += p.platformVel.z;
      p.grounded = false;
    }
  } else {
    // Air control: small influence on velocity
    p.vel.x += wishDir.x * moveSpeed * 0.05;
    p.vel.z += wishDir.z * moveSpeed * 0.05;
  }
}

/**
 * Single physics step for one player against the level.
 */
export function stepPlayer(p: PlayerState, dt: number, level?: LevelDefinition): void {
  const resolvedLevel = resolveLevel(level);
  const wasGrounded = p.grounded;
  p.grounded = false;
  p.platformVel = { x: 0, y: 0, z: 0 };
  if (!isOnLadder(p, resolvedLevel)) p.vel.y -= GRAVITY * dt;

  // Apply friction
  const friction = wasGrounded ? GROUND_FRICTION : AIR_FRICTION;
  p.vel.x *= friction;
  p.vel.z *= friction;

  // Integrate position axis by axis with collision resolution
  p.pos.x += p.vel.x * dt;
  resolveAxis(p, "x", wasGrounded, resolvedLevel);

  p.pos.y += p.vel.y * dt;
  resolveAxis(p, "y", wasGrounded, resolvedLevel);
  resolveMovingPlatforms(p, performance.now(), dt, resolvedLevel);

  p.pos.z += p.vel.z * dt;
  resolveAxis(p, "z", wasGrounded, resolvedLevel);

  clampToLadder(p, resolvedLevel);
  applyJumpPads(p, resolvedLevel);

  if (p.pos.y < getDerivedLevelData(resolvedLevel).fallOutY) {
    p.pos.y = resolvedLevel.spawnPoints[0].y;
    p.vel.y = 0;
    p.pos.x = resolvedLevel.spawnPoints[0].x;
    p.pos.z = resolvedLevel.spawnPoints[0].z;
  }
}

function resolveMovingPlatforms(
  p: PlayerState,
  timeMs: number,
  dt: number,
  level?: LevelDefinition,
): void {
  for (const platform of resolveLevel(level).movingPlatforms) {
    const pos = movingPlatformPosition(platform, timeMs);
    const prevPos = movingPlatformPosition(platform, timeMs - dt * 1000);
    const delta = {
      x: pos.x - prevPos.x,
      y: pos.y - prevPos.y,
      z: pos.z - prevPos.z,
    };
    const box = {
      min: {
        x: pos.x - platform.size.x * 0.5,
        y: pos.y - platform.size.y * 0.5,
        z: pos.z - platform.size.z * 0.5,
      },
      max: {
        x: pos.x + platform.size.x * 0.5,
        y: pos.y + platform.size.y * 0.5,
        z: pos.z + platform.size.z * 0.5,
      },
    };
    const playerBox = playerAABB(p);
    if (!intersectAABB(playerBox, box)) continue;
    if (p.vel.y <= 0 && playerBox.min.y >= box.max.y - 0.4) {
      p.pos.x += delta.x;
      p.pos.z += delta.z;
      p.pos.y = box.max.y + 0.001;
      p.platformVel = { x: delta.x / dt, y: delta.y / dt, z: delta.z / dt };
      p.vel.y = 0;
      p.grounded = true;
    }
  }
}

function applyJumpPads(p: PlayerState, level?: LevelDefinition): void {
  if (p.dead || p.vel.y > 2) return;
  const playerBox = playerAABB(p);
  for (const pad of resolveLevel(level).jumpPads) {
    if (!intersectAABB(playerBox, pad)) continue;
    p.vel.y = pad.force;
    p.grounded = false;
    p.jumpPadSeq++;
    return;
  }
}

function tryStepUp(
  p: PlayerState,
  wasGrounded: boolean,
  hits: { min: Vec3; max: Vec3; color?: number }[],
  level?: LevelDefinition,
): boolean {
  if (!wasGrounded) return false;
  const maxStep = SETTINGS.player.maxStepHeight;
  const originalY = p.pos.y;
  const colliders = getDerivedLevelData(level).colliders;

  for (const hit of hits) {
    const stepHeight = hit.max.y - originalY;
    if (stepHeight <= 0.05 || stepHeight > maxStep) continue;
    p.pos.y = hit.max.y + 0.001;
    const steppedBox = playerAABB(p);
    if (colliders.every((box) => !intersectAABB(steppedBox, box))) {
      p.grounded = true;
      p.vel.y = 0;
      return true;
    }
  }

  p.pos.y = originalY;
  return false;
}

function resolveAxis(
  p: PlayerState,
  axis: "x" | "y" | "z",
  wasGrounded: boolean,
  level?: LevelDefinition,
): void {
  const colliders = getDerivedLevelData(level).colliders;
  if (axis !== "y") {
    const playerBox = playerAABB(p);
    const hits = colliders.filter((box) => intersectAABB(playerBox, box));
    if (hits.length > 0 && tryStepUp(p, wasGrounded, hits, level)) return;
  }

  for (const box of colliders) {
    const playerBox = playerAABB(p);
    if (!intersectAABB(playerBox, box)) continue;

    if (axis === "x") {
      if (p.vel.x > 0) {
        p.pos.x = box.min.x - PLAYER_RADIUS - 0.001;
      } else if (p.vel.x < 0) {
        p.pos.x = box.max.x + PLAYER_RADIUS + 0.001;
      } else {
        const pushLeft = Math.abs(playerBox.max.x - box.min.x);
        const pushRight = Math.abs(box.max.x - playerBox.min.x);
        p.pos.x += pushLeft < pushRight ? -pushLeft : pushRight;
      }
      p.vel.x = 0;
    } else if (axis === "z") {
      if (p.vel.z > 0) {
        p.pos.z = box.min.z - PLAYER_RADIUS - 0.001;
      } else if (p.vel.z < 0) {
        p.pos.z = box.max.z + PLAYER_RADIUS + 0.001;
      } else {
        const pushBack = Math.abs(playerBox.max.z - box.min.z);
        const pushForward = Math.abs(box.max.z - playerBox.min.z);
        p.pos.z += pushBack < pushForward ? -pushBack : pushForward;
      }
      p.vel.z = 0;
    } else {
      if (p.vel.y <= 0) {
        p.pos.y = box.max.y + 0.001;
        p.vel.y = 0;
        p.grounded = true;
      } else {
        const height = p.crouching ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT;
        p.pos.y = box.min.y - height - 0.001;
        p.vel.y = 0;
      }
    }
  }
}

/**
 * Re-simulate a player from a known good state using an ordered list of inputs.
 * Returns the new state without mutating the original.
 */
export function resimulate(initial: PlayerState, inputs: PlayerInput[], dt: number): PlayerState {
  const p = clonePlayerState(initial);
  for (const input of inputs) {
    applyInput(p, input);
    stepPlayer(p, dt);
  }
  return p;
}
