/**
 * WeaponModels.js — detailed first-person weapons, built from bevelled solids.
 *
 * Every weapon is modelled to real-world dimensions (metres) so the viewmodel
 * reads at the correct scale in the hand: a 14.5" carbine really is ~0.84 m.
 *
 * Each builder returns { group, parts, muzzle, ejectPort, sightAxis } where
 * `parts` exposes the sub-groups the animator drives (magazine, charging
 * handle, bolt, trigger) and `muzzle` / `ejectPort` are empty Object3Ds the
 * FX layer spawns flashes and shell casings from.
 */

import * as THREE from 'three';
import { PartBuilder, normalizeGeo, rbox, box, cylinder, sphere, torus, wedge, tube, strut, at } from './ModelKit.js';

/* ------------------------------------------------------------- helpers --- */

/** Picatinny rail: transverse ribs merged into one geometry. */
function rail(len, width = 0.021, height = 0.009) {
  const geos = [];
  geos.push(box(width, height * 0.45, len));
  const pitch = 0.01005;
  const count = Math.floor(len / pitch);
  for (let i = 0; i < count; i++) {
    const z = -len / 2 + pitch * 0.5 + i * pitch;
    geos.push(at(box(width, height, 0.0056), [0, height * 0.32, z]));
  }
  return geos;
}

/** Birdcage flash hider with cut slots. Returned geometry runs along Z. */
function flashHider(r = 0.0115, len = 0.058) {
  const geos = [];
  // body (cylinders are Y-up, so lay them down the barrel axis)
  geos.push(at(cylinder(r, r * 1.05, len, 14), [0, 0, 0], [Math.PI / 2, 0, 0]));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.4;
    // slot cuts through the wall, radially placed around the Z axis
    geos.push(at(box(0.0035, r * 0.8, len * 0.5),
      [Math.cos(a) * r * 0.97, Math.sin(a) * r * 0.97, -len * 0.06], [0, 0, a]));
  }
  geos.push(at(cylinder(r * 1.02, r * 1.02, 0.007, 14), [0, 0, -len / 2 + 0.004], [Math.PI / 2, 0, 0]));
  geos.push(at(cylinder(r * 0.55, r * 0.55, 0.010, 12), [0, 0, len / 2 - 0.002], [Math.PI / 2, 0, 0]));
  return geos;
}

/** Standard capacity magazine, gently curved (5.56). */
function curvedMag(rounds, height = 0.075, depth = 0.030, width = 0.0255) {
  const geos = [];
  const segs = 4;
  const segH = height / segs;
  for (let i = 0; i < segs; i++) {
    const t = i / segs;
    const bend = -0.055 * Math.pow(t + 1 / segs, 1.7);
    geos.push(at(
      rbox(width, segH * 1.02, depth - t * 0.008, 0.004),
      [0, -segH * (i + 0.5), bend],
      [THREE.MathUtils.degToRad(-9 * (i + 1)), 0, 0],
    ));
  }
  // floor plate + witness holes
  geos.push(at(rbox(width * 1.06, 0.008, depth * 1.05, 0.003), [0, -height - 0.004, -0.055 * 1.5]));
  return geos;
}

function opticDot() {
  const geos = [];
  // T-1 style red dot: body tube, mount base, lens rings
  geos.push(at(cylinder(0.0165, 0.0165, 0.042, 18, true), [0, 0.048, 0], [Math.PI / 2, 0, 0]));
  geos.push(at(rbox(0.030, 0.014, 0.044, 0.004), [0, 0.004, 0]));
  geos.push(at(rbox(0.038, 0.020, 0.014, 0.003), [0, 0.018, -0.012]));
  geos.push(at(cylinder(0.0195, 0.0195, 0.006, 18, true), [0, 0.048, 0.021], [Math.PI / 2, 0, 0]));
  geos.push(at(cylinder(0.0205, 0.0205, 0.008, 18, true), [0, 0.048, -0.021], [Math.PI / 2, 0, 0]));
  return geos;
}

export function createWeaponMaterials(base) {
  const M = Object.assign(Object.create(null), base);
  M.weaponSteel = base.gunSteel;
  M.gunPolymer = base.polymer;
  M.gunWood = base.wood;
  M.brass = new THREE.MeshStandardMaterial({ color: 0xb28f45, metalness: 1.0, roughness: 0.28, envMapIntensity: 1.4 });
  M.tracerless = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, metalness: 0.8, roughness: 0.5 });
  M.opticGlass = new THREE.MeshPhysicalMaterial({
    color: 0x2c4a3c, metalness: 0, roughness: 0.045, ior: 1.52,
    transmission: 0.92, thickness: 0.004, transparent: true, opacity: 0.55,
    side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 2.2,
  });
  M.reticle = new THREE.MeshBasicMaterial({ color: 0xff3322, transparent: true, opacity: 0.92, toneMapped: false });
  M.weaponAccent = new THREE.MeshStandardMaterial({ color: 0x3a3d40, metalness: 1, roughness: 0.62, envMapIntensity: 1.1 });
  return M;
}

/* --------------------------------------------------------------- M4A1 --- */

/**
 * 5.56 mm carbine — flat-top receiver, quad-rail handguard, red dot, collapsible stock.
 */
export function buildCarbine(M) {
  const b = new PartBuilder();
  const steel = 'weaponSteel';
  const poly = 'gunPolymer';

  /* --- upper receiver ---------------------------------------------------- */
  b.add(steel, rbox(0.040, 0.058, 0.185, 0.007, 0.0025));
  b.add(steel, at(box(0.021, 0.009, 0.20), [0, 0.031, -0.005]));      // top rail bed
  rail(0.215, 0.021).forEach((g) => b.add(steel, at(g, [0, 0.0335, -0.005])));
  // ejection port + dust cover
  b.add(poly, at(box(0.0025, 0.026, 0.062), [0.0208, 0.004, 0.020]));
  b.add(steel, at(rbox(0.004, 0.028, 0.058, 0.002), [0.0218, 0.006, 0.018], [0, 0, -0.25]));
  b.add(steel, at(cylinder(0.008, 0.008, 0.016, 12), [0.024, -0.004, 0.052], [0, 0, Math.PI / 2])); // brass deflector
  b.add(steel, at(cylinder(0.0075, 0.0075, 0.020, 12), [0.019, -0.012, -0.052], [0, 0, Math.PI / 2])); // forward assist
  // charging handle (animated part)
  b.add(steel, at(rbox(0.026, 0.0075, 0.012, 0.002), [0, 0.024, 0.098]));

  /* --- handguard / quad rail -------------------------------------------- */
  b.add(poly, at(cylinder(0.0245, 0.0245, 0.235, 8, true), [0, 0.012, -0.30], [Math.PI / 2, 0, Math.PI / 8]));
  // top rail continues over the handguard; side rails roll outward
  rail(0.23, 0.019).forEach((g) => b.add(steel, at(g, [0, 0.0345, -0.30])));
  rail(0.23, 0.018).forEach((g) => b.add(steel, at(g, [0.0265, 0.012, -0.30], [0, 0, -Math.PI / 2])));
  rail(0.23, 0.018).forEach((g) => b.add(steel, at(g, [-0.0265, 0.012, -0.30], [0, 0, Math.PI / 2])));
  b.add(poly, at(box(0.030, 0.008, 0.20), [0, -0.012, -0.30]));       // bottom rail bed
  // heat-shield ribs visible through the slats
  for (let i = 0; i < 6; i++) b.add(steel, at(box(0.050, 0.003, 0.006), [0, 0.012, -0.205 - i * 0.036]));
  b.add(poly, at(rbox(0.030, 0.055, 0.030, 0.006), [0, -0.055, -0.245], [0.28, 0, 0]));   // angled foregrip

  /* --- barrel group ----------------------------------------------------- */
  b.add(steel, at(cylinder(0.0105, 0.0105, 0.34, 16), [0, 0.012, -0.585], [Math.PI / 2, 0, 0]));
  b.add(steel, at(cylinder(0.0185, 0.0185, 0.05, 14), [0, 0.012, -0.30], [Math.PI / 2, 0, 0]));  // barrel nut
  b.add(steel, at(rbox(0.026, 0.036, 0.052, 0.005), [0, 0.014, -0.505]));                        // low-profile gas block
  b.add(steel, at(cylinder(0.0032, 0.0032, 0.24, 8), [0, 0.030, -0.44], [Math.PI / 2, 0, 0]));   // gas tube
  flashHider(0.0124, 0.062).forEach((g) => b.add(steel, at(g, [0, 0.012, -0.788])));
  // front sight tower (kept folded down)
  b.add(steel, at(rbox(0.022, 0.030, 0.020, 0.003), [0, 0.034, -0.44], [0.5, 0, 0]));

  /* --- lower receiver --------------------------------------------------- */
  b.add(steel, rbox(0.036, 0.030, 0.165, 0.006, 0.002));
  b.add(steel, at(rbox(0.038, 0.052, 0.040, 0.005), [0, -0.030, 0.004], [0.16, 0, 0]));   // magwell
  b.add(steel, at(rbox(0.034, 0.012, 0.030, 0.004), [0, -0.012, -0.052]));                // front of magwell
  // trigger guard + trigger
  b.add(poly, at(box(0.006, 0.004, 0.042), [0.014, -0.048, -0.006]));
  b.add(poly, at(box(0.006, 0.004, 0.042), [-0.014, -0.048, -0.006]));
  b.add(poly, at(box(0.026, 0.004, 0.008), [0, -0.062, -0.024]));
  b.add(steel, at(rbox(0.007, 0.024, 0.009, 0.002), [0, -0.042, -0.010], [0.2, 0, 0]));
  // controls
  b.add(steel, at(cylinder(0.005, 0.005, 0.006, 10), [0.019, -0.008, -0.048], [0, 0, Math.PI / 2]));
  b.add(steel, at(rbox(0.018, 0.005, 0.007, 0.0015), [0.023, -0.008, -0.058], [0, 0.4, 0]));
  b.add(steel, at(cylinder(0.0045, 0.0045, 0.028, 10), [0.019, -0.004, 0.010], [0, 0, Math.PI / 2]));  // selector axle
  b.add(steel, at(rbox(0.005, 0.022, 0.006, 0.0015), [0.030, -0.002, 0.010], [0.9, 0, 0]));            // selector lever
  b.add(steel, at(cylinder(0.0035, 0.0035, 0.032, 8), [0.019, -0.020, 0.050], [0, 0, Math.PI / 2]));   // takedown pin
  b.add(steel, at(cylinder(0.0035, 0.0035, 0.032, 8), [0.019, -0.018, -0.038], [0, 0, Math.PI / 2]));  // pivot pin
  b.add(steel, at(rbox(0.004, 0.012, 0.020, 0.001), [0, -0.012, 0.062]));                              // bolt catch

  /* --- pistol grip ------------------------------------------------------ */
  b.add(poly, at(rbox(0.031, 0.098, 0.046, 0.012, 0.004), [0, -0.098, 0.028], [0.34, 0, 0]));
  b.add(poly, at(box(0.030, 0.006, 0.034), [0, -0.140, 0.098], [0.34, 0, 0]));   // grip base swell
  b.add(poly, at(rbox(0.033, 0.012, 0.048, 0.005), [0, -0.146, 0.100], [0.34, 0, 0]));

  /* --- buffer tube + collapsible stock ---------------------------------- */
  b.add(steel, at(cylinder(0.0185, 0.0185, 0.20, 16, true), [0, 0.012, 0.155], [Math.PI / 2, 0, 0]));
  b.add(steel, at(cylinder(0.021, 0.021, 0.014, 6), [0, 0.012, 0.070], [Math.PI / 2, 0, 0]));    // castle nut
  for (let i = 0; i < 6; i++) b.add(steel, at(box(0.006, 0.004, 0.222), [0.021, 0.012 + (i - 2.5) * 0.0045, 0.158]));
  b.add(poly, at(rbox(0.048, 0.070, 0.115, 0.014, 0.004), [0, -0.012, 0.212]));
  b.add(poly, at(rbox(0.044, 0.024, 0.055, 0.008), [0, 0.028, 0.196]));                          // cheek riser
  b.add(poly, at(rbox(0.050, 0.086, 0.020, 0.010, 0.003), [0, -0.012, 0.278]));                  // butt pad
  b.add(steel, at(box(0.014, 0.010, 0.030), [0, -0.040, 0.196]));                                 // lever
  b.add(poly, at(box(0.004, 0.014, 0.020), [0, -0.062, 0.190], [0, 0, 0]));                       // sling loop

  /* --- optic ------------------------------------------------------------ */
  opticDot().forEach((g) => b.add(steel, at(g, [0, 0.012, 0.010])));
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.0016, 8, 8), M.reticle);
  dot.position.set(0, 0.060, 0.010);

  const group = b.build(M);
  group.name = 'M4A1';

  /* --- animation nodes -------------------------------------------------- */
  const nodes = {};

  const mag = new PartBuilder();
  curvedMag(30).forEach((g) => mag.add(steel, at(g, [0, -0.030, 0.006])));
  mag.add(poly, at(box(0.026, 0.006, 0.032), [0, -0.026, 0.006]));
  nodes.magazine = mag.build(M);
  nodes.magazine.name = 'magazine';
  nodes.magazine.position.set(0, -0.052, 0.004);
  group.add(nodes.magazine);

  const bolt = new PartBuilder();
  bolt.add(steel, rbox(0.024, 0.020, 0.070, 0.004));
  bolt.add(steel, at(cylinder(0.008, 0.008, 0.022, 10), [0, 0, -0.040], [Math.PI / 2, 0, 0]));
  nodes.bolt = bolt.build(M);
  nodes.bolt.name = 'bolt';
  nodes.bolt.visible = false;
  group.add(nodes.bolt);

  nodes.charging = new THREE.Object3D();
  nodes.charging.name = 'chargingHandle';
  nodes.charging.position.set(0, 0.024, 0.098);
  group.add(nodes.charging);

  nodes.muzzle = new THREE.Object3D();
  nodes.muzzle.name = 'muzzle';
  nodes.muzzle.position.set(0, 0.012, -0.822);
  group.add(nodes.muzzle);

  nodes.ejectPort = new THREE.Object3D();
  nodes.ejectPort.name = 'ejectPort';
  nodes.ejectPort.position.set(0.030, 0.006, 0.020);
  group.add(nodes.ejectPort);

  nodes.sightAxis = new THREE.Object3D();
  nodes.sightAxis.name = 'sightAxis';
  nodes.sightAxis.position.set(0, 0.060, 0.010);
  group.add(nodes.sightAxis);

  group.add(dot);

  // Muzzle device flash anchor faces forward (-Z)
  return { group, nodes, dot, length: 0.86, adsOffset: new THREE.Vector3(0, 0.060, 0) };
}

/* ----------------------------------------------------------------- AKM --- */

export function buildAKM(M) {
  const b = new PartBuilder();
  const steel = 'weaponAccent';
  const poly = 'gunPolymer';
  const wood = 'gunWood';

  /* --- receiver --------------------------------------------------------- */
  b.add(steel, rbox(0.038, 0.062, 0.245, 0.005, 0.002));
  b.add(steel, at(box(0.040, 0.006, 0.245), [0, 0.030, 0]));
  b.add(steel, at(rbox(0.030, 0.020, 0.010, 0.003), [0, -0.040, 0.118]));   // rear trunnion block
  b.add(steel, at(rbox(0.036, 0.030, 0.030, 0.004), [0, 0.010, -0.135]));   // front trunnion
  // stamped rivets
  for (let i = 0; i < 5; i++) b.add(steel, at(cylinder(0.0028, 0.0028, 0.040, 6), [0, -0.010 + i * 0.012, -0.105 + i * 0.05], [0, 0, Math.PI / 2]));
  // dust cover with ribs
  b.add(steel, at(rbox(0.032, 0.018, 0.150, 0.004), [0, 0.028, 0.030]));
  for (let i = 0; i < 6; i++) b.add(steel, at(box(0.026, 0.003, 0.008), [0, 0.036, -0.02 + i * 0.022]));

  /* --- gas system + barrel ---------------------------------------------- */
  b.add(steel, at(cylinder(0.0115, 0.0115, 0.415, 16), [0, 0.012, -0.415], [Math.PI / 2, 0, 0]));
  b.add(steel, at(cylinder(0.0165, 0.0165, 0.115, 14), [0, 0.014, -0.245], [Math.PI / 2, 0, 0]));  // gas block
  b.add(steel, at(cylinder(0.0095, 0.0095, 0.170, 12), [0, 0.041, -0.235], [Math.PI / 2, 0, 0]));   // gas tube
  b.add(wood, at(rbox(0.036, 0.048, 0.130, 0.010), [0, 0.014, -0.300]));                            // upper handguard
  b.add(wood, at(rbox(0.040, 0.050, 0.150, 0.012), [0, -0.006, -0.315]));                           // lower handguard
  b.add(steel, at(cylinder(0.0145, 0.0145, 0.022, 14), [0, 0.012, -0.399], [Math.PI / 2, 0, 0]));   // handguard cap
  // slanted muzzle brake
  b.add(steel, at(cylinder(0.0125, 0.0115, 0.048, 14), [0, 0.012, -0.645], [Math.PI / 2, 0, 0]));
  b.add(steel, at(rbox(0.024, 0.020, 0.016, 0.004), [0, 0.024, -0.640], [0.3, 0, 0]));

  /* --- sights ----------------------------------------------------------- */
  b.add(steel, at(rbox(0.008, 0.036, 0.010, 0.002), [0, 0.062, -0.575]));          // front post
  b.add(steel, at(rbox(0.036, 0.008, 0.012, 0.003), [0, 0.044, -0.575]));           // front sight ears
  b.add(steel, at(rbox(0.006, 0.030, 0.008, 0.002), [0.014, 0.070, -0.575]));
  b.add(steel, at(rbox(0.006, 0.030, 0.008, 0.002), [-0.014, 0.070, -0.575]));
  b.add(steel, at(rbox(0.040, 0.010, 0.030, 0.003), [0, 0.044, -0.055]));           // tangent rear sight
  b.add(steel, at(rbox(0.024, 0.016, 0.006, 0.002), [0, 0.054, -0.070], [-0.25, 0, 0]));
  b.add(steel, at(box(0.005, 0.012, 0.028), [0, 0.048, 0.020]));                    // sight rail bed

  /* --- trigger group ---------------------------------------------------- */
  b.add(steel, at(rbox(0.030, 0.020, 0.060, 0.004), [0, -0.044, -0.070]));
  b.add(steel, at(rbox(0.008, 0.030, 0.010, 0.002), [0, -0.052, -0.078], [0.18, 0, 0]));
  b.add(steel, at(box(0.006, 0.005, 0.062), [0.015, -0.062, -0.070]));
  b.add(steel, at(box(0.006, 0.005, 0.062), [-0.015, -0.062, -0.070]));
  b.add(steel, at(rbox(0.006, 0.026, 0.030, 0.003), [0.019, -0.020, 0.010], [0, 0, 0]));  // selector
  b.add(poly, at(box(0.006, 0.014, 0.012), [0.024, -0.058, 0.036]));                      // mag release

  /* --- furniture -------------------------------------------------------- */
  b.add(poly, at(rbox(0.033, 0.100, 0.048, 0.012, 0.004), [0, -0.098, 0.058], [0.30, 0, 0]));
  b.add(poly, at(box(0.031, 0.006, 0.036), [0, -0.142, 0.124], [0.30, 0, 0]));
  b.add(wood, at(rbox(0.040, 0.070, 0.190, 0.012, 0.004), [0, -0.020, 0.205], [0.06, 0, 0]));  // wooden stock
  b.add(wood, at(rbox(0.044, 0.090, 0.020, 0.008), [0, -0.028, 0.300], [0.06, 0, 0]));         // butt plate
  b.add(steel, at(box(0.014, 0.010, 0.026), [0, -0.050, 0.190]));                              // sling swivel

  const group = b.build(M);
  group.name = 'AKM';

  const nodes = {};
  const magB = new PartBuilder();
  // heavily curved 7.62 magazine
  for (let i = 0; i < 5; i++) {
    const t = i / 5;
    magB.add(steel, at(rbox(0.028, 0.026, 0.052 - t * 0.008, 0.004),
      [0, -0.016 * (i + 0.5), -0.012 - 0.10 * Math.pow(t + 0.2, 1.8)],
      [THREE.MathUtils.degToRad(-14 * (i + 1)), 0, 0]));
  }
  magB.add(poly, at(box(0.030, 0.008, 0.058), [0, -0.086, -0.115], [-0.5, 0, 0]));
  nodes.magazine = magB.build(M);
  nodes.magazine.name = 'magazine';
  nodes.magazine.position.set(0, -0.042, -0.062);
  group.add(nodes.magazine);

  const boltB = new PartBuilder();
  boltB.add(steel, rbox(0.022, 0.024, 0.090, 0.004));
  boltB.add(steel, at(cylinder(0.007, 0.007, 0.026, 10), [0.018, 0, 0.030], [0, 0, Math.PI / 2]));
  boltB.add(steel, at(rbox(0.012, 0.014, 0.020, 0.002), [0.026, 0, 0.048]));   // charging handle knob
  nodes.bolt = boltB.build(M);
  nodes.bolt.name = 'boltCarrier';
  group.add(nodes.bolt);

  nodes.muzzle = new THREE.Object3D();
  nodes.muzzle.name = 'muzzle';
  nodes.muzzle.position.set(0, 0.012, -0.700);
  group.add(nodes.muzzle);

  nodes.ejectPort = new THREE.Object3D();
  nodes.ejectPort.name = 'ejectPort';
  nodes.ejectPort.position.set(0.028, 0.020, -0.020);
  group.add(nodes.ejectPort);

  nodes.sightAxis = new THREE.Object3D();
  nodes.sightAxis.position.set(0, 0.066, -0.055);
  nodes.sightAxis.name = 'sightAxis';
  group.add(nodes.sightAxis);

  return { group, nodes, dot: null, length: 0.88, adsOffset: new THREE.Vector3(0, 0.066, 0) };
}

/* -------------------------------------------------------------- pistol --- */

export function buildPistol(M) {
  const b = new PartBuilder();
  const steel = 'weaponAccent';
  const poly = 'gunPolymer';

  // slide
  b.add(steel, rbox(0.031, 0.034, 0.190, 0.007, 0.003));
  b.add(steel, at(rbox(0.030, 0.014, 0.190, 0.005), [0, 0.018, 0]));
  b.add(steel, at(cylinder(0.0085, 0.0085, 0.100, 14), [0, 0, -0.100], [Math.PI / 2, 0, 0]));  // barrel
  b.add(steel, at(rbox(0.020, 0.012, 0.010, 0.002), [0, 0.026, 0.086]));                       // rear sight
  b.add(steel, at(rbox(0.008, 0.014, 0.008, 0.002), [0, 0.026, -0.088]));                      // front sight
  b.add(steel, at(rbox(0.024, 0.020, 0.008, 0.003), [0, -0.012, 0.094]));                      // extractor plate
  for (let i = 0; i < 9; i++) b.add(steel, at(box(0.004, 0.014, 0.005), [0.014, 0.004, 0.058 - i * 0.012]));
  for (let i = 0; i < 9; i++) b.add(steel, at(box(0.004, 0.014, 0.005), [-0.014, 0.004, 0.058 - i * 0.012]));

  // frame
  b.add(poly, at(rbox(0.030, 0.026, 0.170, 0.006), [0, -0.028, 0.004]));
  b.add(steel, at(rbox(0.026, 0.008, 0.070, 0.003), [0, -0.016, -0.058]));                    // dust cover
  b.add(steel, at(box(0.006, 0.005, 0.050), [0.013, -0.042, -0.030]));
  b.add(steel, at(box(0.006, 0.005, 0.050), [-0.013, -0.042, -0.030]));
  b.add(steel, at(rbox(0.007, 0.026, 0.009, 0.002), [0, -0.038, -0.020], [0.2, 0, 0]));       // trigger
  // grip with beavertail + texture panels
  b.add(poly, at(rbox(0.034, 0.118, 0.050, 0.012, 0.004), [0, -0.100, 0.048], [0.28, 0, 0]));
  b.add(poly, at(box(0.036, 0.010, 0.040), [0, -0.150, 0.092], [0.28, 0, 0]));
  b.add(poly, at(rbox(0.036, 0.020, 0.050, 0.006), [0, -0.014, 0.088]));                      // beavertail
  b.add(steel, at(box(0.008, 0.010, 0.016), [-0.018, -0.062, 0.032]));                        // slide stop
  b.add(steel, at(box(0.007, 0.010, 0.012), [0.017, -0.036, 0.032]));                         // mag release
  b.add(poly, at(rbox(0.026, 0.006, 0.030, 0.002), [0, -0.158, 0.098], [0.28, 0, 0]));        // mag base

  const group = b.build(M);
  group.name = 'M9';

  const nodes = {};
  const mb = new PartBuilder();
  mb.add(steel, at(rbox(0.022, 0.075, 0.028, 0.003), [0, -0.040, 0.050], [0.28, 0, 0]));
  nodes.magazine = mb.build(M);
  nodes.magazine.position.set(0, -0.110, 0.052);
  group.add(nodes.magazine);

  const sb = new PartBuilder();
  sb.add(steel, rbox(0.029, 0.034, 0.190, 0.007, 0.003));
  sb.add(steel, at(rbox(0.020, 0.012, 0.010, 0.002), [0, 0.026, 0.086]));
  sb.add(steel, at(rbox(0.008, 0.014, 0.008, 0.002), [0, 0.026, -0.088]));
  nodes.bolt = sb.build(M);   // the whole slide recoils
  nodes.bolt.name = 'slide';
  nodes.bolt.visible = false;
  group.add(nodes.bolt);

  nodes.muzzle = new THREE.Object3D();
  nodes.muzzle.name = 'muzzle';
  nodes.muzzle.position.set(0, 0, -0.156);
  group.add(nodes.muzzle);

  nodes.ejectPort = new THREE.Object3D();
  nodes.ejectPort.position.set(0.026, 0.020, 0.020);
  group.add(nodes.ejectPort);

  nodes.sightAxis = new THREE.Object3D();
  nodes.sightAxis.position.set(0, 0.026, -0.086);
  group.add(nodes.sightAxis);

  return { group, nodes, dot: null, length: 0.22, adsOffset: new THREE.Vector3(0, 0.026, 0) };
}

export const WEAPON_BUILDERS = {
  carbine: buildCarbine,
  akm: buildAKM,
  pistol: buildPistol,
};
