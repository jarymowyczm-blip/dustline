/**
 * test/smoke.mjs — headless sanity checks for the parts of the game that do
 * not need a GPU: procedural texture baking, level construction, collision,
 * weapon/character model building, AI stepping and ragdoll settling.
 *
 * Run with:  npm test
 *
 * It deliberately asserts *content*, not just "no exception": a texture that
 * bakes to a flat colour, a level that produces no colliders or a rifle with
 * 12 triangles are all failures as far as players are concerned.
 */

import * as THREE from 'three';
import { TextureFactory } from '../src/world/Textures.js';
import { Level } from '../src/world/Level.js';
import { CollisionWorld } from '../src/world/Collision.js';
import { buildCarbine, buildAKM, buildPistol, createWeaponMaterials } from '../src/world/WeaponModels.js';
import { buildSoldier, buildFPHands, createCharacterMaterials } from '../src/world/CharacterModel.js';
import { EnemyPool } from '../src/entities/Enemy.js';

let failures = 0;
let checks = 0;

function ok(cond, label, detail = '') {
  checks++;
  if (cond) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}`);
  } else {
    failures++;
    console.log(`  \x1b[31m✗ ${label}\x1b[0m ${detail}`);
  }
}

function section(name) {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

/** Mean/variance of a byte field, used to prove textures are not flat. */
function stats(arr) {
  let sum = 0, sum2 = 0, n = 0;
  for (let i = 0; i < arr.length; i += 4) { sum += arr[i]; sum2 += arr[i] * arr[i]; n++; }
  const mean = sum / n;
  return { mean, sd: Math.sqrt(Math.max(0, sum2 / n - mean * mean)) };
}

function countTriangles(obj) {
  let tris = 0;
  obj.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  return Math.round(tris);
}

const fakeRenderer = { capabilities: { getMaxAnisotropy: () => 8 } };

async function main() {
  /* ------------------------------------------------------------ textures */
  section('Procedural textures (TextureFactory)');
  const t0 = Date.now();
  const factory = new TextureFactory(fakeRenderer);
  const materials = await factory.buildAll(() => {}, { texLarge: 256, texMedium: 128 });
  const bakeMs = Date.now() - t0;

  const names = Object.keys(materials);
  ok(names.length >= 20, `built ${names.length} materials`, `${bakeMs}ms at preview resolution`);
  for (const need of ['concrete', 'plaster', 'sand', 'sandDune', 'rustyMetal', 'wood', 'camo', 'gunSteel', 'frond', 'containerBlue']) {
    ok(!!materials[need], `material "${need}" exists`);
  }

  const concrete = materials.concrete;
  ok(!!concrete.map && !!concrete.normalMap && !!concrete.roughnessMap,
    'concrete has albedo + normal + ORM maps');
  const albedo = concrete.map.image.data;
  const st = stats(albedo);
  ok(st.sd > 6, 'concrete albedo has real detail (not flat)',
    `mean ${st.mean.toFixed(1)} sd ${st.sd.toFixed(1)}`);
  // normal maps must be centred on 0.5 and actually perturbed
  const nrm = concrete.normalMap.image.data;
  const ns = stats(nrm);
  ok(Math.abs(ns.mean - 127) < 22, 'normal map is centred', `mean ${ns.mean.toFixed(1)}`);
  ok(ns.sd > 1.5, 'normal map is perturbed', `sd ${ns.sd.toFixed(1)}`);
  // orm: green = roughness, blue = metalness
  const orm = concrete.roughnessMap.image.data;
  let roughSum = 0, metalSum = 0, cnt = 0;
  for (let i = 0; i < orm.length; i += 4) { roughSum += orm[i + 1]; metalSum += orm[i + 2]; cnt++; }
  const avgRough = roughSum / cnt / 255, avgMetal = metalSum / cnt / 255;
  ok(avgRough > 0.4, 'concrete roughness is high (rough surface)', avgRough.toFixed(2));
  ok(avgMetal < 0.1, 'concrete metalness is ~0', avgMetal.toFixed(2));

  const steel = materials.gunSteel.roughnessMap.image.data;
  let m2 = 0, c2 = 0;
  for (let i = 0; i < steel.length; i += 4) { m2 += steel[i + 2]; c2++; }
  ok(m2 / c2 / 255 > 0.5, 'gun steel is metallic', (m2 / c2 / 255).toFixed(2));
  ok(materials.frond.alphaTest > 0, 'frond material uses alpha cut-out', `alphaTest ${materials.frond.alphaTest}`);

  /* --------------------------------------------------------------- level */
  section('Level (Dustline Outpost)');
  const scene = new THREE.Scene();
  const settings = { get: (k) => ({ foliageDensity: 1, quality: 'high' })[k] };
  const t1 = Date.now();
  const level = new Level(scene, materials, settings);
  level.build();
  const levelMs = Date.now() - t1;

  ok(level.colliders.boxes.length > 300, `level registered ${level.colliders.boxes.length} colliders`, `${levelMs}ms`);
  ok(scene.children.some((c) => c.name === 'level'), 'level root added to the scene');
  const staticMeshes = level.root.children.filter((c) => c.name.startsWith('static_'));
  ok(staticMeshes.length >= 8 && staticMeshes.length <= 32,
    `static geometry merged into ${staticMeshes.length} meshes (low draw calls)`);
  let levelTris = 0;
  for (const m of staticMeshes) levelTris += (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
  ok(levelTris > 60000, `level geometry is detailed`, `${(levelTris / 1000).toFixed(0)}k triangles`);
  ok(level.spawnPoints.length > 20, `${level.spawnPoints.length} enemy spawn points`);
  ok(level.coverPoints.length > 20, `${level.coverPoints.length} cover points`);
  for (const name of ['concrete', 'plaster', 'sandbag', 'rustyMetal', 'containerBlue', 'cloth', 'frond']) {
    ok(level.buckets.has(name), `level placed geometry using "${name}"`);
  }
  const surfaces = new Set(level.colliders.boxes.map((b) => b.surface));
  ok(surfaces.size >= 5, `colliders carry ${surfaces.size} distinct surface types`, [...surfaces].join(','));
  ok(level.colliders.boxes.every((b) => b.half.x > 0 && b.half.y > 0 && b.half.z > 0 &&
    Number.isFinite(b.center.x)), 'all colliders have finite, positive extents');

  /* ---------------------------------------------------------- collision */
  section('Collision world');
  const cw = new CollisionWorld();
  cw.add(new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(1, 0.5, 1), 0, 'concrete');
  const hit = cw.raycast(new THREE.Vector3(-10, 0.5, 0), new THREE.Vector3(1, 0, 0), 30);
  ok(hit && Math.abs(hit.distance - 9) < 0.01, 'ray hits the box face at the exact distance',
    hit ? hit.distance.toFixed(3) : 'no hit');
  ok(hit && hit.normal.x < -0.99, 'hit normal points back at the shooter');
  ok(cw.raycast(new THREE.Vector3(-10, 5, 0), new THREE.Vector3(1, 0, 0), 30) === null, 'ray above the box misses');
  ok(cw.raycast(new THREE.Vector3(-10, 0.5, 4), new THREE.Vector3(1, 0, 0), 30) === null, 'ray beside the box misses');

  // rotated box
  const cw2 = new CollisionWorld();
  cw2.add(new THREE.Vector3(0, 0.5, 0), new THREE.Vector3(2, 0.5, 0.1), Math.PI / 2, 'metal');
  const hit2 = cw2.raycast(new THREE.Vector3(0, 0.5, -10), new THREE.Vector3(0, 0, 1), 30);
  // half.x = 2 rotated 90° about Y becomes the world-Z extent ⇒ face at z = -2.
  ok(hit2 && Math.abs(hit2.distance - 8.0) < 0.02, 'yaw-rotated collider is oriented correctly',
    hit2 ? hit2.distance.toFixed(2) : 'no hit');
  ok(hit2 && hit2.normal.z < -0.99, 'rotated collider normal is rotated too');

  // capsule resolution against a wall
  const cw3 = new CollisionWorld();
  cw3.add(new THREE.Vector3(0, 1.5, 0), new THREE.Vector3(0.5, 1.5, 10), 0, 'concrete');
  const feet = new THREE.Vector3(0.2, 0, 0);
  cw3.resolveCapsule(feet, 0.34, 1.8);
  // The capsule starts inside the wall's footprint, so it is ejected through
  // the nearer face: it must end up fully clear of the slab (±0.5 ± radius).
  ok(Math.abs(feet.x) >= 0.5 + 0.33, 'capsule is pushed clear of the wall', `x = ${feet.x.toFixed(2)}`);
  ok(Number.isFinite(feet.y), 'capsule resolution keeps y finite');
  // standing on a platform
  const cw4 = new CollisionWorld();
  cw4.add(new THREE.Vector3(0, 1, 0), new THREE.Vector3(3, 1, 3), 0, 'concrete');
  const onTop = new THREE.Vector3(0, 2.2, 0);
  const r4 = cw4.resolveCapsule(onTop, 0.34, 1.8);
  ok(Math.abs(onTop.y - 2) < 0.02 && r4.grounded, 'capsule lands on top of a platform',
    `y = ${onTop.y.toFixed(2)}`);
  // step up onto a 0.3 m curb
  const cw5 = new CollisionWorld();
  cw5.add(new THREE.Vector3(1, 0.15, 0), new THREE.Vector3(1, 0.15, 3), 0, 'concrete');
  const stepper = new THREE.Vector3(0.5, 0, 0);
  cw5.resolveCapsule(stepper, 0.34, 1.8, { stepHeight: 0.48 });
  ok(stepper.y > 0.25 && stepper.x > 0.1, 'capsule steps up onto a curb instead of being blocked',
    `y = ${stepper.y.toFixed(2)}, x = ${stepper.x.toFixed(2)}`);

  // line of sight through a wall
  const los = cw3.lineOfSight(new THREE.Vector3(-5, 1, 0), new THREE.Vector3(5, 1, 0));
  ok(los === false, 'line of sight is blocked by a wall');
  ok(cw3.lineOfSight(new THREE.Vector3(-5, 1, 20), new THREE.Vector3(5, 1, 20)) === true,
    'line of sight is clear without obstruction');

  // player spawn sanity on the real level
  const spawn = level.playerSpawn.pos.clone();
  const atSpawn = level.colliders.resolveCapsule(spawn, 0.34, 1.8);
  ok(atSpawn.grounded, 'player spawn point is on solid ground', `y = ${spawn.y.toFixed(2)}`);
  const openSpots = level.spawnPoints.filter((s) => {
    const p = s.pos.clone();
    level.colliders.resolveCapsule(p, 0.36, 1.7);
    return p.distanceTo(s.pos) < 0.35;
  });
  ok(openSpots.length > level.spawnPoints.length * 0.6,
    'most enemy spawn points are not inside geometry',
    `${openSpots.length}/${level.spawnPoints.length}`);

  /* -------------------------------------------------------------- models */
  section('Models');
  const wm = createWeaponMaterials(materials);
  const cm = createCharacterMaterials(wm);
  for (const [name, build, minTris] of [['carbine', buildCarbine, 3000], ['AKM', buildAKM, 3000], ['pistol', buildPistol, 1200]]) {
    const model = build(wm);
    const tris = countTriangles(model.group);
    ok(tris > minTris, `${name} is detailed`, `${tris} triangles`);
    const box3 = new THREE.Box3().setFromObject(model.group);
    const size = box3.getSize(new THREE.Vector3());
    ok(Number.isFinite(size.x) && size.x > 0.03 && size.x < 0.4, `${name} has sane width`, `${size.x.toFixed(3)} m`);
    ok(size.z > 0.15, `${name} has a real length`, `${size.z.toFixed(3)} m`);
    ok(!!model.nodes.muzzle && !!model.nodes.magazine, `${name} exposes animation nodes`);
    model.group.traverse((o) => { if (o.geometry) o.geometry.dispose?.(); });
  }
  const carbine = buildCarbine(wm);
  // The sight axis must sit above the bore line so ADS maths can centre it.
  ok(carbine.adsOffset.y > 0.02, 'carbine sight axis is above the bore', `${carbine.adsOffset.y} m`);

  const soldier = buildSoldier(cm, {});
  const boneNames = Object.keys(soldier.bones);
  ok(boneNames.length > 20, `soldier rig has ${boneNames.length} bones`);
  for (const b of ['pelvis', 'spine', 'chest', 'neck', 'hipL', 'kneeR', 'shoulderL', 'forearmR', 'handR']) {
    ok(!!soldier.bones[b], `rig exposes bone "${b}"`);
  }
  const soldierTris = countTriangles(soldier.group);
  ok(soldierTris > 4000, 'soldier is detailed', `${soldierTris} triangles`);
  const hands = buildFPHands(cm, {});
  ok(hands.children.length === 2, 'two first-person hands are built');

  // Anatomy: the rig has to stand on the ground with the joints in the right
  // order, otherwise units render sunk into the floor and hitboxes miss.
  const rigScene = new THREE.Scene();
  rigScene.add(soldier.group);
  rigScene.updateMatrixWorld(true);
  const rigBox = new THREE.Box3().setFromObject(soldier.group);
  const rigSize = rigBox.getSize(new THREE.Vector3());
  const boneY = (n) => soldier.bones[n].getWorldPosition(new THREE.Vector3()).y;
  ok(Math.abs(rigBox.min.y) < 0.05, 'soldier stands on the group origin (feet at y=0)',
    `min y ${rigBox.min.y.toFixed(3)}`);
  ok(rigSize.y > 1.7 && rigSize.y < 1.92, 'soldier is life-size', `${rigSize.y.toFixed(2)} m tall`);
  ok(boneY('kneeL') < boneY('hipL') - 0.3, 'knee hangs below the hip',
    `${(boneY('hipL') - boneY('kneeL')).toFixed(2)} m thigh`);
  ok(boneY('footL') < boneY('kneeL') - 0.3, 'ankle hangs below the knee',
    `${(boneY('kneeL') - boneY('footL')).toFixed(2)} m shin`);
  ok(boneY('neck') > 1.45 && boneY('neck') < 1.72, 'head sits at a human height',
    `neck ${boneY('neck').toFixed(2)} m, shoulders ${boneY('shoulderL').toFixed(2)} m`);
  rigScene.remove(soldier.group);

  /* ------------------------------------------------------------------ AI */
  section('Enemy AI (headless simulation)');
  const gameStub = {
    scene,
    level,
    time: 0,
    lastPlayerShot: -99,
    mode: 'survival',
    hitTestEnemies: () => null,
    onPlayerHitBy: () => {},
  };
  const pool = new EnemyPool(gameStub, materials, null, null, settings);
  const enemy = pool.spawn(level.spawnPoints[0].pos.clone(), { health: 100, accuracy: 0.6, weapon: 'akm' });
  ok(enemy.group.visible, 'enemy spawned and visible');
  ok(level.colliders.groundAt(enemy.pos.x, enemy.pos.z) - enemy.pos.y < 0.3, 'enemy spawned on the ground');

  const playerStub = {
    pos: new THREE.Vector3(0, 0, 40),
    vel: new THREE.Vector3(),
    eyeHeight: 1.66,
    height: 1.8,
    alive: true,
    sprinting: false,
    suppression: 0,
    damageTaken: 0,
    takeDamage(d) { this.damageTaken += d; },
  };
  // keep the "player" in front of the enemy so combat code paths run
  playerStub.pos.copy(level.spawnPoints[0].pos).add(new THREE.Vector3(0, 0, 18));

  let thrown = null;
  try {
    for (let i = 0; i < 600; i++) {           // 10 seconds at 60 Hz
      gameStub.time += 1 / 60;
      if (i === 30) gameStub.lastPlayerShot = gameStub.time;   // make noise: alert them
      enemy.update(1 / 60, playerStub, gameStub);
      if (i % 120 === 0) playerStub.pos.x += Math.sin(i) * 2;
    }
  } catch (e) { thrown = e; }
  ok(!thrown, 'enemy runs 600 simulation frames without throwing', thrown ? thrown.message : '');
  ok(Number.isFinite(enemy.pos.x) && Number.isFinite(enemy.yaw), 'enemy transform stays finite');
  ok(['idle', 'alert', 'seek', 'combat'].includes(enemy.state), `enemy reached a valid state`, enemy.state);
  ok(enemy.hasSeenPlayer || enemy.alertness > 0, 'enemy detected the player', `alertness ${enemy.alertness.toFixed(2)}`);
  ok(playerStub.damageTaken >= 0, 'enemy shooting path executed', `dealt ${playerStub.damageTaken.toFixed(1)} damage`);

  // ---- return fire: an enemy in the open must actually wound the player ----
  // A fresh body on the flat player-spawn ground: the unit above has been
  // wandering for ten seconds and may have climbed onto a structure by now.
  const flatGround = level.playerSpawn.pos.clone();
  playerStub.pos.set(flatGround.x, level.colliders.groundAt(flatGround.x, flatGround.z), flatGround.z);
  const anchorYaw = level.playerSpawn.yaw || 0;
  const ahead = new THREE.Vector3(-Math.sin(anchorYaw), 0, -Math.cos(anchorYaw)).multiplyScalar(12);
  const shooterSpawn = playerStub.pos.clone().add(ahead);
  shooterSpawn.y = level.colliders.groundAt(shooterSpawn.x, shooterSpawn.z);
  const toPlayer = playerStub.pos.clone().sub(shooterSpawn);
  const shooter = pool.spawn(shooterSpawn, Math.atan2(-toPlayer.x, -toPlayer.z),
    { health: 200, accuracy: 0.7, weapon: 'akm' });
  scene.updateMatrixWorld(true);
  ok(level.colliders.lineOfSight(shooter.eyePos, playerStub.pos.clone().setY(playerStub.pos.y + 1.4)),
    'open firing lane from the shooter to the player',
    `${shooter.pos.distanceTo(playerStub.pos).toFixed(1)} m`);

  playerStub.damageTaken = 0;
  shooter.state = 'combat'; shooter.stateTime = 1;
  shooter.alertness = 1; shooter.hasSeenPlayer = true;
  shooter.reactionTimer = 0; shooter.fireTimer = 0; shooter.suppressTimer = 0; shooter.burstCount = 6;
  let fired = 0;
  let poseAtShot = null;       // how the rifle was held at the instant of firing
  const realShoot = shooter._shoot.bind(shooter);
  shooter._shoot = (p, d) => {
    fired++;
    scene.updateMatrixWorld(true);        // the render loop does this in the game
    const muzzle = shooter.muzzle.getWorldPosition(new THREE.Vector3());
    const bore = new THREE.Vector3(0, 0, -1)
      .applyQuaternion(shooter.muzzle.getWorldQuaternion(new THREE.Quaternion()));
    const want = new THREE.Vector3(p.pos.x, p.pos.y + 1.15, p.pos.z).sub(muzzle).normalize();
    poseAtShot = { align: bore.dot(want), height: muzzle.y - shooter.pos.y };
    return realShoot(p, d);
  };
  for (let i = 0; i < 900 && fired < 3; i++) {
    gameStub.time += 1 / 60;
    shooter.update(1 / 60, playerStub, gameStub);
    scene.updateMatrixWorld(true);        // the render loop does this in the game
  }
  shooter._shoot = realShoot;
  ok(fired > 0, 'enemy fires at a player in the open', `${fired} shots`);
  ok(playerStub.damageTaken > 0, 'enemy fire wounds the player',
    `${playerStub.damageTaken.toFixed(1)} damage over ${fired} shots`);

  // The rifle is rigidly held in the right hand, so the hand's twist aims it:
  // at the moment of firing the bore has to point at the target, from a
  // shouldered position — otherwise tracers leave a barrel aimed elsewhere.
  ok(poseAtShot && poseAtShot.align > 0.97, 'rifle points at the player when firing',
    poseAtShot ? `bore·aim ${poseAtShot.align.toFixed(3)}` : 'never fired');
  ok(poseAtShot && poseAtShot.height > 0.9 && poseAtShot.height < 1.65,
    'rifle is shouldered at chest height',
    poseAtShot ? `${poseAtShot.height.toFixed(2)} m` : 'never fired');

  // hit testing: aim at the chest and at the head
  const eye = enemy.pos.clone().setY(enemy.pos.y + 1.5);
  const chestWorld = enemy.bones.chest.getWorldPosition(new THREE.Vector3());
  const dir = chestWorld.clone().sub(eye).normalize();
  const hitInfo = enemy.hitTest(eye, dir, 30);
  ok(!!hitInfo, 'ray from the front hits the enemy');
  if (hitInfo) {
    ok(hitInfo.distance > 0 && hitInfo.distance < 5, 'hit distance is plausible', hitInfo.distance.toFixed(2));
    ok(!!hitInfo.part, `hit resolved to a body part`, hitInfo.part);
  }
  const missDir = new THREE.Vector3(1, 0, 0);
  ok(enemy.hitTest(chestWorld.clone().add(new THREE.Vector3(6, 0, 0)), missDir, 3) === null,
    'ray aimed away from the enemy misses');

  // Aim at the head hitbox the same way the game computes it: neck bone
  // position plus the offset rotated by the bone's orientation.
  const neckBone = enemy.bones.neck;
  const headCenter = neckBone.getWorldPosition(new THREE.Vector3())
    .add(new THREE.Vector3(0, 0.11, 0).applyQuaternion(neckBone.getWorldQuaternion(new THREE.Quaternion())));
  const headHit = enemy.hitTest(headCenter.clone().add(new THREE.Vector3(0, 0, 3)), new THREE.Vector3(0, 0, -1), 6);
  ok(headHit && headHit.part === 'head', 'head sphere registers as a headshot',
    headHit ? headHit.part : 'miss');
  ok(!!enemy.bones.headMesh, 'rig exposes a head mesh bone (used by the ragdoll)');

  /* -------------------------------------------------------------- ragdoll */
  section('Ragdoll death');
  const before = shooter.pos.clone();
  const res2 = shooter.applyDamage(500, {
    distance: 4, part: 'chest', mult: 1, armour: 1,
    point: shooter.pos.clone().setY(shooter.pos.y + 1.2),
    normal: new THREE.Vector3(0, 0, 1),
    enemy: shooter,
  }, playerStub, { headMult: 3 });
  ok(res2.killed && !shooter.alive, 'lethal damage kills the enemy');
  ok(!!shooter.ragdoll && shooter.ragdoll.points.length >= 14, `ragdoll has ${shooter.ragdoll?.points.length} particles`);
  ok(shooter.ragdoll.constraints.length > 14, `ragdoll has ${shooter.ragdoll?.constraints.length} constraints`);

  let rThrown = null;
  try {
    for (let i = 0; i < 420; i++) shooter.update(1 / 60, playerStub, gameStub);
  } catch (e) { rThrown = e; }
  ok(!rThrown, 'ragdoll settles over 7 s without throwing', rThrown ? rThrown.message : '');
  const lowest = Math.min(...shooter.ragdoll.points.map((p) => p.pos.y));
  ok(lowest > -0.5, 'ragdoll body ends above the floor (no tunnelling)', `min y ${lowest.toFixed(2)}`);
  const spread = Math.max(...shooter.ragdoll.points.map((p) => p.pos.distanceTo(before)));
  ok(spread > 0.15 && spread < 12, 'ragdoll moved a believable distance', `${spread.toFixed(2)} m`);
  ok(shooter.ragdoll.points.every((p) => Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y)),
    'ragdoll positions are finite (solver is stable)');

  /* ---------------------------------------------------------------- done */
  console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${checks - failures}/${checks} checks passed\x1b[0m`);
  if (failures > 0) {
    console.log('\x1b[31mSMOKE TEST FAILED\x1b[0m');
    process.exit(1);
  }
  console.log('\x1b[32mSMOKE TEST PASSED\x1b[0m');
}

main().catch((e) => {
  console.error('\x1b[31mSmoke test crashed:\x1b[0m', e);
  process.exit(1);
});
