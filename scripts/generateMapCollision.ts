// Build-time script: parse the downloaded AFPS level OBJ and generate mapData.ts.
// Usage: deno run --allow-read --allow-write scripts/generateMapCollision.ts

import {
  Decoration,
  JumpPad,
  LadderZone,
  LevelBox,
  MovingPlatform,
  PickupSpawn,
  Vec3,
} from "../src/shared/protocol.ts";

const OBJ_PATH = "public/assets/online/afps-level/level.obj";
const OUT_PATH = "src/shared/mapData.ts";
const CELL_SIZE = 0.5;
const SCALE = 6;

interface Triangle {
  a: Vec3;
  b: Vec3;
  c: Vec3;
}

function parseObj(source: string): { vertices: Vec3[]; triangles: Triangle[] } {
  const vertices: Vec3[] = [];
  const triangles: Triangle[] = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("v ")) {
      const parts = trimmed.split(/\s+/).slice(1).map(Number);
      vertices.push({ x: parts[0] * SCALE, y: parts[1] * SCALE, z: parts[2] * SCALE });
    } else if (trimmed.startsWith("f ")) {
      const parts = trimmed.split(/\s+/).slice(1);
      const indices = parts.map((p) => Number(p.split("/")[0]) - 1);
      for (let i = 1; i < indices.length - 1; i++) {
        triangles.push({
          a: vertices[indices[0]],
          b: vertices[indices[i]],
          c: vertices[indices[i + 1]],
        });
      }
    }
  }
  return { vertices, triangles };
}

function key(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

function voxelize(triangles: Triangle[]): Set<string> {
  const solid = new Set<string>();
  for (const tri of triangles) {
    const minX = Math.floor(Math.min(tri.a.x, tri.b.x, tri.c.x) / CELL_SIZE);
    const maxX = Math.floor(Math.max(tri.a.x, tri.b.x, tri.c.x) / CELL_SIZE);
    const minY = Math.floor(Math.min(tri.a.y, tri.b.y, tri.c.y) / CELL_SIZE);
    const maxY = Math.floor(Math.max(tri.a.y, tri.b.y, tri.c.y) / CELL_SIZE);
    const minZ = Math.floor(Math.min(tri.a.z, tri.b.z, tri.c.z) / CELL_SIZE);
    const maxZ = Math.floor(Math.max(tri.a.z, tri.b.z, tri.c.z) / CELL_SIZE);
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        for (let z = minZ; z <= maxZ; z++) {
          solid.add(key(x, y, z));
        }
      }
    }
  }
  return solid;
}

function greedyBoxes(solid: Set<string>): LevelBox[] {
  const used = new Set<string>();
  const boxes: LevelBox[] = [];
  const cells = [...solid]
    .map((k) => k.split(",").map(Number))
    .sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);

  for (const [sx, sy, sz] of cells) {
    if (used.has(key(sx, sy, sz))) continue;

    let ex = sx;
    while (solid.has(key(ex + 1, sy, sz)) && !used.has(key(ex + 1, sy, sz))) ex++;

    let ey = sy;
    let ok = true;
    while (ok) {
      for (let x = sx; x <= ex; x++) {
        if (!solid.has(key(x, ey + 1, sz)) || used.has(key(x, ey + 1, sz))) {
          ok = false;
          break;
        }
      }
      if (ok) ey++;
    }

    let ez = sz;
    ok = true;
    while (ok) {
      for (let x = sx; x <= ex; x++) {
        for (let y = sy; y <= ey; y++) {
          if (!solid.has(key(x, y, ez + 1)) || used.has(key(x, y, ez + 1))) {
            ok = false;
            break;
          }
        }
        if (!ok) break;
      }
      if (ok) ez++;
    }

    for (let x = sx; x <= ex; x++) {
      for (let y = sy; y <= ey; y++) {
        for (let z = sz; z <= ez; z++) {
          used.add(key(x, y, z));
        }
      }
    }

    boxes.push({
      min: { x: sx * CELL_SIZE, y: sy * CELL_SIZE, z: sz * CELL_SIZE },
      max: { x: (ex + 1) * CELL_SIZE, y: (ey + 1) * CELL_SIZE, z: (ez + 1) * CELL_SIZE },
      color: 0x64748b,
    });
  }

  return boxes;
}

function generateSpawnPoints(boxes: LevelBox[]): Vec3[] {
  // Place spawns on top of broad, flat floor-like boxes so players don't fall through gaps.
  // Avoid deep pits that are below the respawn threshold.
  const SAFE_FLOOR_Y = -10;
  const candidates = boxes
    .map((box) => {
      const sx = box.max.x - box.min.x;
      const sy = box.max.y - box.min.y;
      const sz = box.max.z - box.min.z;
      const area = sx * sz;
      return {
        x: (box.min.x + box.max.x) * 0.5,
        y: box.max.y,
        z: (box.min.z + box.max.z) * 0.5,
        area,
        thin: sy <= 1.2,
      };
    })
    .filter((c) => c.thin && c.area >= 4 && c.y > SAFE_FLOOR_Y)
    .sort((a, b) => b.area - a.area);

  // Pick a representative set spread across the map.
  const spawns: Vec3[] = [];
  const minSpacing = 8;
  for (const candidate of candidates) {
    if (spawns.length >= 8) break;
    if (spawns.every((s) => Math.hypot(s.x - candidate.x, s.z - candidate.z) >= minSpacing)) {
      spawns.push({ x: candidate.x, y: candidate.y + 0.05, z: candidate.z });
    }
  }

  // Fallback to the largest candidates if spacing filter leaves us short.
  for (const candidate of candidates) {
    if (spawns.length >= 8) break;
    if (!spawns.some((s) => Math.hypot(s.x - candidate.x, s.z - candidate.z) < 0.1)) {
      spawns.push({ x: candidate.x, y: candidate.y + 0.05, z: candidate.z });
    }
  }

  return spawns;
}

function generatePickups(vertices: Vec3[]): PickupSpawn[] {
  const xs = vertices.map((v) => v.x);
  const zs = vertices.map((v) => v.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  const cx = (minX + maxX) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  return [
    {
      id: "rifle-mid",
      type: "weapon",
      weaponId: "rifle",
      label: "RIFLE",
      pos: { x: cx, y: 1.5, z: cz },
      respawnMs: 12000,
    },
    {
      id: "sniper-nw",
      type: "weapon",
      weaponId: "sniper",
      label: "SNIPER",
      pos: { x: minX + 1.5, y: 1.5, z: minZ + 1.5 },
      respawnMs: 18000,
    },
    {
      id: "sniper-se",
      type: "weapon",
      weaponId: "sniper",
      label: "SNIPER",
      pos: { x: maxX - 1.5, y: 1.5, z: maxZ - 1.5 },
      respawnMs: 18000,
    },
    {
      id: "ammo-west",
      type: "ammo",
      label: "AMMO",
      amount: 999,
      pos: { x: minX + 2, y: 0.5, z: cz },
      respawnMs: 8000,
    },
    {
      id: "ammo-east",
      type: "ammo",
      label: "AMMO",
      amount: 999,
      pos: { x: maxX - 2, y: 0.5, z: cz },
      respawnMs: 8000,
    },
    {
      id: "ammo-mid-a",
      type: "ammo",
      label: "AMMO",
      amount: 999,
      pos: { x: cx, y: 0.5, z: minZ + 2 },
      respawnMs: 8000,
    },
    {
      id: "ammo-mid-b",
      type: "ammo",
      label: "AMMO",
      amount: 999,
      pos: { x: cx, y: 0.5, z: maxZ - 2 },
      respawnMs: 8000,
    },
  ];
}

function serializeVec3(v: Vec3): string {
  return `{ x: ${v.x.toFixed(4)}, y: ${v.y.toFixed(4)}, z: ${v.z.toFixed(4)} }`;
}

function serializeBox(box: LevelBox): string {
  return `  { min: ${serializeVec3(box.min)}, max: ${serializeVec3(box.max)}, color: ${box.color} }`;
}

const source = await Deno.readTextFile(OBJ_PATH);
const { vertices, triangles } = parseObj(source);
const solid = voxelize(triangles);
const boxes = greedyBoxes(solid);
const spawnPoints = generateSpawnPoints(boxes);
const pickups = generatePickups(vertices);

const jumpPads: JumpPad[] = [];
const movingPlatforms: MovingPlatform[] = [];
const ladders: LadderZone[] = [];
const decorations: Decoration[] = [];

const code = `// Auto-generated by scripts/generateMapCollision.ts from public/assets/online/afps-level/level.obj
import { Decoration, JumpPad, LadderZone, LevelBox, MovingPlatform, PickupSpawn, Vec3 } from "./protocol.ts";

export const MAP_SCALE = ${SCALE};

export const LEVEL: LevelBox[] = [
${boxes.map(serializeBox).join(",\n")},
];

export const SPAWN_POINTS: Vec3[] = [
${spawnPoints.map(serializeVec3).join(",\n")},
];

export const PICKUP_SPAWNS: PickupSpawn[] = [
${pickups.map((p) => `  { id: "${p.id}", type: "${p.type}", ${p.weaponId ? `weaponId: "${p.weaponId}", ` : ""}label: "${p.label}", ${p.amount !== undefined ? `amount: ${p.amount}, ` : ""}pos: ${serializeVec3(p.pos)}, respawnMs: ${p.respawnMs} }`).join(",\n")},
];

export const JUMP_PADS: JumpPad[] = ${JSON.stringify(jumpPads)};
export const MOVING_PLATFORMS: MovingPlatform[] = ${JSON.stringify(movingPlatforms)};
export const LADDERS: LadderZone[] = ${JSON.stringify(ladders)};
export const DECORATIONS: Decoration[] = ${JSON.stringify(decorations)};
`;

await Deno.writeTextFile(OUT_PATH, code);
console.log(
  `Generated ${OUT_PATH} with ${boxes.length} collision boxes, ${spawnPoints.length} spawns, ${pickups.length} pickups.`,
);
