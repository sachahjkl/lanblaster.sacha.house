# Handoff

## State
- Client/server build, lint, format check, and type check all pass.
- Recent changes: 6x map scaling, noise-textured OBJ map rendering, room ID tags, pause-menu Exit Room button, server room/join/leave logs.

## Current known issues
1. **Map** — using a downloaded low-poly AFPS OBJ. Collision is auto-voxelized from it. Visuals still look low-poly/odd and some spawn areas are pits; players can walk off the map into the void because the big ground plane is visual-only.
2. **Muzzle coordinates** — weapons are Kenney blaster GLBs. Bullets currently originate from a generic hand offset. Each model needs its actual muzzle position so projectiles come out of the barrel, not the grip.
3. **Gun rotation** — fixed 180° Y issue for first/third person, but verify in-game.

## Next steps
1. **Fix or replace the map**
   - Option A: find a better replacement OBJ/GLB arena that is closed, has clear floors, and fits the player scale.
   - Option B: generate a simple custom arena in code (boxes + floor) and drop the OBJ dependency.
   - If keeping the OBJ, add a real collision floor (infinite ground plane or closed arena bounds) so players can't fall into the void.
2. **Identify muzzle coordinates per weapon model**
   - Models: `blaster-a.glb` (pistol), `blaster-r.glb` (rifle), `blaster-j.glb` (sniper), `blaster-d.glb` (shotgun).
   - Load each in a quick Three.js viewer/script, find the world-space tip of the barrel relative to the model root, and store offsets.
   - Use those offsets in `src/client/renderer.ts` bullet spawn code and mirror them server-side in `src/shared/physics.ts`/`src/server/server.ts` fire logic.
3. **Polish**
   - Verify spawns never place players over void/pits.
   - Tune map scale if replaced (player speed/height feel right at current 6x AFPS scale).

## Key files
- `src/client/renderer.ts` — map loading, weapon visuals, bullet tracer spawn.
- `src/shared/mapData.ts` — generated collision/spawns/pickups.
- `scripts/generateMapCollision.ts` — map OBJ → collision/spawn generator.
- `src/shared/physics.ts` — server authority physics, fire ray origin.
- `src/server/server.ts` — room lifecycle, join/leave logs.
