/**
 * CharacterModel.js — detailed soldier rigs and first-person hands.
 *
 * The rig is a plain Object3D hierarchy (pelvis → spine → chest → head, plus
 * four limb chains). Meshes hang off each bone, so procedural animation in
 * Enemy.js only touches rotations — and the same bone transforms can be fed to
 * the ragdoll solver when the unit dies.
 *
 * Proportions follow an average adult male: 1.80 m tall, 0.44 m thigh,
 * 0.28 m forearm, eye height ~1.68 m.
 */

import * as THREE from 'three';
import { PartBuilder, rbox, box, cylinder, sphere, torus, at, mirrored, strut } from './ModelKit.js';

export function createCharacterMaterials(base) {
  const M = Object.assign(Object.create(null), base);
  M.skin = new THREE.MeshStandardMaterial({ color: 0x8f6d52, roughness: 0.58, metalness: 0, envMapIntensity: 0.9 });
  M.uniform = base.camo;
  M.webbing = new THREE.MeshStandardMaterial({
    color: 0x59543f, roughness: 0.90, metalness: 0.02, envMapIntensity: 0.7,
  });
  M.vestPoly = new THREE.MeshStandardMaterial({
    color: 0x3b3f36, roughness: 0.72, metalness: 0.05, envMapIntensity: 0.8,
  });
  M.leather = new THREE.MeshStandardMaterial({ color: 0x2c2723, roughness: 0.68, metalness: 0.03, envMapIntensity: 0.8 });
  M.goggle = new THREE.MeshPhysicalMaterial({
    color: 0x14181c, roughness: 0.08, metalness: 0.55, clearcoat: 1, clearcoatRoughness: 0.05,
    envMapIntensity: 2.0,
  });
  M.helmetShell = new THREE.MeshStandardMaterial({ color: 0x4a4c42, roughness: 0.66, metalness: 0.08, envMapIntensity: 0.85 });
  M.velcro = new THREE.MeshStandardMaterial({ color: 0x8a8668, roughness: 0.96, metalness: 0, envMapIntensity: 0.6 });

  // Blood decal colour used by the damage system.
  M.blood = new THREE.MeshStandardMaterial({
    color: 0x4a0d0a, roughness: 0.35, metalness: 0, transparent: true, opacity: 0.9,
    polygonOffset: true, polygonOffsetFactor: -4, depthWrite: false,
  });
  return M;
}

/* ------------------------------------------------------------ primitives - */

/**
 * Create a bone (pivot) with a tapered mesh hanging off it.
 * The bone points down its own local -Y, so rotating a parent swings the limb.
 */
function boneMesh(parent, name, { len, rTop, rBot, material, build, from = [0, 0, 0] }) {
  const bone = new THREE.Object3D();
  bone.name = name;
  // Limb chains hang downward: the child joint sits at the parent's far end.
  bone.position.set(from[0], from[1], from[2]);
  parent.add(bone);
  const b = build || ((builder) => {
    builder.add(material, at(rbox(rTop * 2, len, rBot * 2, Math.min(rTop, rBot) * 0.7, 0.004), [0, -len / 2, 0]));
  });
  const bb = new PartBuilder();
  b(bb);
  const mesh = bb.build(MATERIALS_REF);
  mesh.name = `${name}_mesh`;
  for (const child of [...mesh.children]) { child.castShadow = true; child.receiveShadow = true; }
  bone.add(mesh);
  return bone;
}

// Set by buildSoldier before any bone is created (keeps the helper tiny).
let MATERIALS_REF = null;

/* --------------------------------------------------------------- rig ----- */

/**
 * @param {Object} materials library from TextureFactory + character extras
 * @returns {{group: THREE.Group, bones: Object, meshes: Object[], height: number}}
 */
export function buildSoldier(materials, opts = {}) {
  // Skeleton is authored around the hip: lift it so the group origin is the
  // ground and the boots land on y = 0, matching Player/TYPE_HEIGHT (1.8 m).
  const HIP_HEIGHT = 0.96;
  MATERIALS_REF = materials;
  const camo = 'uniform';
  const webbing = 'webbing';
  const vest = 'vestPoly';
  const skin = 'skin';
  const leather = 'leather';
  const helmetMat = 'helmetShell';

  const group = new THREE.Group();
  group.name = opts.name || 'soldier';

  const bones = {};
  const root = new THREE.Object3D();
  root.name = 'root';
  root.position.set(0, HIP_HEIGHT, 0);
  group.add(root);

  // ---------------------------------------------------------------- legs --
  const legLen = 0.47, shinLen = 0.46;
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? -1 : 1;
    const hip = new THREE.Object3D();
    hip.name = `hip${side}`;
    hip.position.set(s * 0.095, 0, 0);
    root.add(hip);
    bones[`hip${side}`] = hip;
    bones[`thigh${side}`] = boneMesh(hip, `thigh${side}`, {
      len: legLen, rTop: 0.085, rBot: 0.068, material: camo,
    });
    bones[`knee${side}`] = boneMesh(bones[`thigh${side}`], `knee${side}`, {
      len: shinLen, rTop: 0.066, rBot: 0.048, material: camo, from: [0, -legLen, 0],
    });
    // knee pad on the knee bone (rigid, sits at the joint)
    const kp = new PartBuilder();
    kp.add(vest, at(rbox(0.105, 0.10, 0.075, 0.032, 0.006), [0, 0.005, -0.045], [0.18, 0, 0]));
    bones[`kneePad${side}`] = bones[`knee${side}`].add(kp.build(materials));
    // boot
    const boot = new PartBuilder();
    boot.add(leather, at(rbox(0.098, 0.095, 0.20, 0.026, 0.006), [0, 0.035, 0.028]));    // boot shaft + ankle collar
    boot.add(leather, at(rbox(0.106, 0.030, 0.27, 0.012, 0.005), [0, -0.014, 0.046]));   // sole, toe forward
    boot.add(vest, at(rbox(0.090, 0.05, 0.075, 0.018, 0.004), [0, 0.025, -0.075]));      // heel counter
    bones[`foot${side}`] = new THREE.Object3D();
    bones[`foot${side}`].name = `foot${side}`;
    bones[`foot${side}`].position.set(0, -shinLen, 0);
    bones[`knee${side}`].add(bones[`foot${side}`]);
    bones[`foot${side}`].add(boot.build(materials));
  }

  // -------------------------------------------------------------- pelvis --
  bones.pelvis = new THREE.Object3D();
  bones.pelvis.name = 'pelvis';
  root.add(bones.pelvis);
  {
    const b = new PartBuilder();
    b.add(camo, at(rbox(0.30, 0.20, 0.19, 0.035, 0.006), [0, 0.02, 0]));
    b.add(webbing, at(rbox(0.315, 0.055, 0.205, 0.012, 0.004), [0, 0.075, 0]));    // belt
    b.add(vest, at(rbox(0.10, 0.13, 0.06, 0.02, 0.005), [-0.14, -0.01, 0.10]))     // side pouches
    b.add(vest, at(rbox(0.10, 0.13, 0.06, 0.02, 0.005), [0.14, -0.01, 0.10]));
    b.add(vest, at(rbox(0.12, 0.10, 0.07, 0.02, 0.005), [0, -0.01, -0.11]));       // rear pouch
    bones.pelvisMesh = b.build(materials);
    bones.pelvisMesh.castShadow = true;
    bones.pelvis.add(bones.pelvisMesh);
  }

  // --------------------------------------------------------------- spine --
  bones.spine = new THREE.Object3D();
  bones.spine.name = 'spine';
  bones.spine.position.set(0, 0.11, 0);
  bones.pelvis.add(bones.spine);

  bones.chest = new THREE.Object3D();
  bones.chest.name = 'chest';
  bones.chest.position.set(0, 0.17, 0);
  bones.spine.add(bones.chest);

  {
    const b = new PartBuilder();
    // torso volume: chest, lats, traps, abdomen
    b.add(camo, at(rbox(0.40, 0.24, 0.22, 0.045, 0.008), [0, 0.02, 0]));
    b.add(camo, at(rbox(0.34, 0.16, 0.20, 0.04, 0.008), [0, 0.16, 0]));
    b.add(camo, at(rbox(0.315, 0.14, 0.19, 0.04, 0.008), [0, -0.12, 0]));          // abdomen
    // plate carrier: front + back plates, cummerbund, straps
    b.add(vest, at(rbox(0.30, 0.34, 0.05, 0.028, 0.008), [0, 0.02, 0.115]));
    b.add(vest, at(rbox(0.29, 0.34, 0.05, 0.028, 0.008), [0, 0.02, -0.115]));
    b.add(vest, at(rbox(0.44, 0.14, 0.20, 0.02, 0.005), [0, -0.10, 0]));           // cummerbund
    b.add(webbing, at(rbox(0.10, 0.20, 0.035, 0.012, 0.004), [-0.13, 0.16, 0.06], [0, 0, 0.22]));
    b.add(webbing, at(rbox(0.10, 0.20, 0.035, 0.012, 0.004), [0.13, 0.16, 0.06], [0, 0, -0.22]));
    // mag pouches
    for (let i = -1; i <= 1; i++) {
      b.add(vest, at(rbox(0.085, 0.115, 0.045, 0.014, 0.004), [i * 0.095, -0.075, 0.135]));
      b.add(webbing, at(rbox(0.090, 0.020, 0.050, 0.008, 0.003), [i * 0.095, -0.018, 0.135]));
    }
    // radio + antenna
    b.add(vest, at(rbox(0.065, 0.10, 0.04, 0.012, 0.004), [-0.165, 0.10, 0.10]));
    b.add(vest, at(cylinder(0.004, 0.004, 0.30, 6), [-0.175, 0.28, 0.09]));
    // utility pouch + knife
    b.add(vest, at(rbox(0.09, 0.09, 0.05, 0.014, 0.004), [0.155, -0.02, 0.115]));
    b.add(leather, at(rbox(0.035, 0.14, 0.05, 0.008, 0.003), [-0.19, -0.06, -0.06], [0.2, 0, 0]));
    bones.chestMesh = b.build(materials);
    bones.chestMesh.castShadow = true;
    bones.chest.add(bones.chestMesh);
  }

  // ---------------------------------------------------------------- head --
  bones.neck = new THREE.Object3D();
  bones.neck.name = 'neck';
  bones.neck.position.set(0, 0.30, 0);
  bones.chest.add(bones.neck);
  {
    const b = new PartBuilder();
    b.add(skin, at(cylinder(0.052, 0.058, 0.09, 10), [0, 0.015, 0]));
    // skull + jaw + ears
    b.add(skin, at(sphere(0.093, 18, 14), [0, 0.115, -0.004]));
    b.add(skin, at(rbox(0.135, 0.12, 0.17, 0.05, 0.01), [0, 0.075, 0.012]));
    b.add(skin, at(sphere(0.022, 8, 8), [-0.092, 0.11, 0.005]));
    b.add(skin, at(sphere(0.022, 8, 8), [0.092, 0.11, 0.005]));
    // shemagh / face wrap leaving a small eye gap
    b.add(webbing, at(rbox(0.155, 0.085, 0.15, 0.045, 0.01), [0, 0.062, 0.012]));
    b.add(webbing, at(rbox(0.165, 0.10, 0.05, 0.03, 0.008), [0, 0.055, -0.062], [0.25, 0, 0]));
    // eyes (dark slits) + brow shadow
    b.add('goggle', at(rbox(0.115, 0.020, 0.012, 0.006, 0.002), [0, 0.105, 0.088]));
    // helmet: shell, brim, rails, NVG mount, cover fabric
    b.add(helmetMat, at(sphere(0.108, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.58), [0, 0.112, -0.008]));
    b.add('uniform', at(sphere(0.111, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.42), [0, 0.112, -0.008]));
    b.add(helmetMat, at(rbox(0.20, 0.022, 0.055, 0.01, 0.004), [0, 0.132, 0.098], [0.12, 0, 0]));
    b.add(helmetMat, at(rbox(0.022, 0.055, 0.16, 0.008, 0.003), [-0.104, 0.135, -0.01]));
    b.add(helmetMat, at(rbox(0.022, 0.055, 0.16, 0.008, 0.003), [0.104, 0.135, -0.01]));
    b.add('weaponAccent', at(rbox(0.055, 0.04, 0.05, 0.008, 0.003), [0, 0.155, 0.115]));   // NVG shroud
    b.add(webbing, at(rbox(0.17, 0.05, 0.06, 0.012, 0.004), [0, 0.055, -0.085], [0.4, 0, 0])); // nape strap
    bones.headMesh = b.build(materials);
    bones.headMesh.castShadow = true;
    bones.neck.add(bones.headMesh);

    // goggles pushed up on the helmet
    const g = new PartBuilder();
    g.add('vestPoly', at(rbox(0.13, 0.055, 0.045, 0.018, 0.005), [0, 0.148, 0.118], [0.2, 0, 0]));
    g.add('goggle', at(rbox(0.115, 0.038, 0.02, 0.014, 0.004), [0, 0.150, 0.132], [0.2, 0, 0]));
    bones.neck.add(g.build(materials));
  }

  // ---------------------------------------------------------------- arms --
  const upperLen = 0.29, foreLen = 0.27;
  for (const side of ['L', 'R']) {
    const s = side === 'L' ? -1 : 1;
    const shoulder = new THREE.Object3D();
    shoulder.name = `shoulder${side}`;
    shoulder.position.set(s * 0.205, 0.20, 0);
    bones.chest.add(shoulder);
    bones[`shoulder${side}`] = shoulder;

    const upper = new PartBuilder();
    upper.add(camo, at(rbox(0.105, upperLen, 0.105, 0.032, 0.006), [0, -upperLen / 2, 0]));
    upper.add(vest, at(rbox(0.125, 0.11, 0.125, 0.038, 0.008), [0, -0.045, 0]));       // shoulder pad
    upper.add(camo, at(sphere(0.055, 10, 8), [0, -0.005, 0]));                        // deltoid cap
    bones[`upperArm${side}`] = new THREE.Object3D();
    bones[`upperArm${side}`].name = `upperArm${side}`;
    shoulder.add(bones[`upperArm${side}`]);
    bones[`upperArm${side}`].add(upper.build(materials));

    const fore = new PartBuilder();
    fore.add(camo, at(rbox(0.088, foreLen, 0.088, 0.024, 0.005), [0, -foreLen / 2, 0]));
    fore.add(camo, at(rbox(0.092, 0.07, 0.092, 0.024, 0.005), [0, -0.035, 0]));
    bones[`forearm${side}`] = new THREE.Object3D();
    bones[`forearm${side}`].name = `forearm${side}`;
    bones[`forearm${side}`].position.set(0, -upperLen, 0);
    bones[`upperArm${side}`].add(bones[`forearm${side}`]);
    bones[`forearm${side}`].add(fore.build(materials));

    // gloved hand
    const h = new PartBuilder();
    h.add(leather, at(rbox(0.085, 0.095, 0.055, 0.022, 0.005), [0, -0.045, 0]));
    h.add(leather, at(rbox(0.075, 0.035, 0.06, 0.014, 0.004), [0, -0.10, 0.01], [0.3, 0, 0]));
    h.add(leather, at(rbox(0.028, 0.055, 0.032, 0.012, 0.003), [s * 0.05, -0.05, 0.02], [0, 0, s * 0.4]));
    // The hand is its own pivot so the ragdoll can pin it to the weapon grip.
    bones[`hand${side}`] = new THREE.Object3D();
    bones[`hand${side}`].name = `hand${side}`;
    bones[`hand${side}`].position.set(0, -foreLen, 0);
    bones[`forearm${side}`].add(bones[`hand${side}`]);
    bones[`hand${side}`].add(h.build(materials));
  }

  // Optional weapon held by the AI (attached to the right hand).
  if (opts.weapon) {
    bones[`handR`].add(opts.weapon);
  }

  const meshes = [];
  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; meshes.push(o); } });

  return { group, bones, meshes, height: 1.8 };
}

/* ------------------------------------------------------ first-person hands - */

/**
 * Gloved hands for the viewmodel, modelled in weapon space.
 * Right hand wraps the pistol grip, left hand supports the handguard/foregrip.
 */
export function buildFPHands(materials, layout = {}) {
  const out = new THREE.Group();
  out.name = 'hands';

  const mkHand = (side, pos, rot, grip = 1) => {
    const b = new PartBuilder();
    const s = side === 'L' ? -1 : 1;
    // palm + knuckles
    b.add('leather', at(rbox(0.075, 0.115, 0.060, 0.026, 0.006), [0, 0, 0]));
    b.add('leather', at(rbox(0.045, 0.09, 0.062, 0.022, 0.005), [s * 0.055, -0.01, 0.004], [0, 0, s * 0.25]));
    // fingers wrapping the grip
    for (let i = 0; i < 4; i++) {
      const t = i / 3;
      b.add('leather', at(rbox(0.058 - t * 0.008, 0.024, 0.052, 0.011, 0.003),
        [s * 0.012, 0.032 - i * 0.028, 0.045 * grip], [0.5 * grip, 0, 0]));
    }
    // thumb
    b.add('leather', at(rbox(0.030, 0.062, 0.030, 0.013, 0.003), [-s * 0.03, 0.03, 0.03 * grip], [0.6, 0, s * 0.5]));
    // forearm stub + sleeve so the arm doesn't end abruptly
    b.add('uniform', at(rbox(0.088, 0.085, 0.090, 0.028, 0.006), [-s * 0.012, -0.02, -0.115 * grip], [0, 0, 0]));
    b.add('uniform', at(rbox(0.098, 0.13, 0.10, 0.03, 0.008), [-s * 0.02, -0.02, -0.215 * grip]));
    b.add('velcro', at(rbox(0.10, 0.05, 0.105, 0.02, 0.005), [-s * 0.02, 0.005, -0.15 * grip]));

    const g = b.build(materials);
    g.position.set(pos[0], pos[1], pos[2]);
    g.rotation.set(rot[0], rot[1], rot[2]);
    return g;
  };

  // Default layout suits an AR-pattern rifle; weapons override via layout.
  const rightPos = layout.rightPos || [0.028, -0.115, 0.075];
  const rightRot = layout.rightRot || [0.30, 0.18, 0.10];
  const leftPos = layout.leftPos || [-0.030, -0.075, -0.245];
  const leftRot = layout.leftRot || [0.15, -0.55, -0.15];

  out.add(mkHand('R', rightPos, rightRot, 1));
  out.add(mkHand('L', leftPos, leftRot, 0.85));
  return out;
}
