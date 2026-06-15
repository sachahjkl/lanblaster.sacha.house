import {
  clonePlayerState,
  cloneVec3,
  GRAVITY,
  GROUND_FRICTION,
  AIR_FRICTION,
  JUMP_PADS,
  LADDERS,
  JUMP_SPEED,
  LEVEL,
  MOVING_PLATFORMS,
  PLAYER_CROUCH_HEIGHT,
  PlayerInput,
  PlayerState,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  SPAWN_POINTS,
  Vec3,
  WEAPONS,
  movingPlatformPosition,
} from "./protocol.ts";
import { SETTINGS } from "./settings.ts";

export function createPlayer(id: string, spawnIndex = 0): PlayerState {
  const spawn = SPAWN_POINTS[spawnIndex % SPAWN_POINTS.length];
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
    lastProcessedInputSeq: 0,
  };
}

export function resetPlayer(p: PlayerState, spawnIndex = 0): void {
  const spawn = SPAWN_POINTS[spawnIndex % SPAWN_POINTS.length];
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

export function muzzlePosition(p: PlayerState): Vec3 {
  const cy = Math.cos(p.yaw);
  const sy = Math.sin(p.yaw);
  const yawForward = { x: sy, z: -cy };
  const yawRight = { x: cy, z: sy };
  const dir = lookDirection(p);
  const weapon = SETTINGS.weaponVisuals;

  const center = {
    x: p.pos.x + yawForward.x * weapon.forwardHandOffset + yawRight.x * weapon.rightHandOffset,
    y: p.pos.y + weapon.handHeight,
    z: p.pos.z + yawForward.z * weapon.forwardHandOffset + yawRight.z * weapon.rightHandOffset,
  };
  if (p.aiming) {
    center.x = p.pos.x + yawForward.x * (weapon.forwardHandOffset + 0.04);
    center.y = p.pos.y + weapon.handHeight + 0.1;
    center.z = p.pos.z + yawForward.z * (weapon.forwardHandOffset + 0.04);
  }

  return {
    x: center.x + dir.x * weapon.muzzleForwardOffset,
    y: center.y + weapon.muzzleUpOffset + dir.y * weapon.muzzleForwardOffset,
    z: center.z + dir.z * weapon.muzzleForwardOffset,
  };
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

export function raycastLevel(origin: Vec3, dir: Vec3, maxDist: number): number | null {
  let best: number | null = null;
  for (const box of LEVEL) {
    const t = rayIntersectAABB(origin, dir, box);
    if (t !== null && t <= maxDist && (best === null || t < best)) {
      best = t;
    }
  }
  return best;
}

export function raycastPlayers(
  origin: Vec3,
  dir: Vec3,
  maxDist: number,
  excludeId: string,
  players: PlayerState[],
): { player: PlayerState; t: number } | null {
  let best: { player: PlayerState; t: number } | null = null;
  for (const p of players) {
    if (p.id === excludeId || p.dead) continue;
    const t = rayIntersectAABB(origin, dir, playerAABB(p));
    if (t !== null && t <= maxDist && (best === null || t < best.t)) {
      best = { player: p, t };
    }
  }
  return best;
}

export function aimTargetPoint(p: PlayerState, maxDist: number, players: PlayerState[] = []): Vec3 {
  const eye = eyePosition(p);
  const look = lookDirection(p);
  const levelHit = raycastLevel(eye, look, maxDist);
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

function isOnLadder(p: PlayerState): boolean {
  const box = playerAABB(p);
  return LADDERS.some((ladder) => intersectAABB(box, ladder));
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
export function stepPlayer(p: PlayerState, dt: number): void {
  const wasGrounded = p.grounded;
  p.grounded = false;
  p.platformVel = { x: 0, y: 0, z: 0 };
  if (!isOnLadder(p)) p.vel.y -= GRAVITY * dt;

  // Apply friction
  const friction = wasGrounded ? GROUND_FRICTION : AIR_FRICTION;
  p.vel.x *= friction;
  p.vel.z *= friction;

  // Integrate position axis by axis with collision resolution
  p.pos.x += p.vel.x * dt;
  resolveAxis(p, "x");

  p.pos.y += p.vel.y * dt;
  resolveAxis(p, "y");
  resolveMovingPlatforms(p, performance.now(), dt);

  p.pos.z += p.vel.z * dt;
  resolveAxis(p, "z");

  applyJumpPads(p);

  // Simple floor / ceiling clamp if outside world
  if (p.pos.y < -20) {
    p.pos.y = 10;
    p.vel.y = 0;
    p.pos.x = 0;
    p.pos.z = 0;
  }
}

function resolveMovingPlatforms(p: PlayerState, timeMs: number, dt: number): void {
  for (const platform of MOVING_PLATFORMS) {
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

function applyJumpPads(p: PlayerState): void {
  if (p.dead || p.vel.y > 2) return;
  const playerBox = playerAABB(p);
  for (const pad of JUMP_PADS) {
    if (!intersectAABB(playerBox, pad)) continue;
    p.vel.y = pad.force;
    p.grounded = false;
    p.jumpPadSeq++;
    return;
  }
}

function resolveAxis(p: PlayerState, axis: "x" | "y" | "z"): void {
  for (const box of LEVEL) {
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
