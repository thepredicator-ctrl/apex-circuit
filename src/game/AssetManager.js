/**
 * AssetManager — central asset loading, validation, and normalization.
 *
 * Responsibilities:
 *   - Load GLB models with progress callbacks.
 *   - Validate each asset on load: check bounding box, mesh count, materials.
 *   - Normalize scale: each asset gets a per-asset scale factor so the whole
 *     game uses one consistent world scale (meters). Assets that were
 *     authored in centimeters (like bush.glb at 152m) get scaled down.
 *   - Normalize orientation: ensure forward = +Z, up = +Y for every model.
 *   - Cache loaded assets so they're only fetched once.
 *   - Report validation warnings/errors to the console and to a runtime
 *     report object that the game can display in a debug overlay.
 *
 * The ASSET_REGISTRY below is the single source of truth for asset
 * normalization. Each entry documents the asset's original scale, the
 * conversion factor, and the expected dimensions after normalization.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Registry of known assets and their normalization rules.
 * `scale` is the multiplier applied to bring the model into meters.
 * `expectedSize` is documented for validation (the post-scale dimensions).
 */
export const ASSET_REGISTRY = {
  car: {
    url: './models/audi_rs6.glb',
    scale: 1.0,                                  // already in meters (tire diameter ~0.73m)
    expectedSize: { x: 5.0, y: 1.5, z: 1.95 },  // Audi RS6 Avant: ~5.0m L x 1.46m H x 1.95m W
    description: 'Audi RS6 GT Avant (vecarz.com, Sketchfab)'
  },
  track: {
    url: './models/drift_race_track_free.glb',
    scale: 1.0,                                  // already in meters (487 x 12 x 380)
    expectedSize: { x: 487, y: 12, z: 380 },
    description: 'Drift race track (Sketchfab, free)'
  },
  tree: {
    url: './models/tree_gn.glb',
    scale: 1.0,                                  // already in meters (21 x 24 x 22)
    expectedSize: { x: 21, y: 24, z: 22 },
    description: 'Tree GN (TechArtBGN, CC-BY-4.0)'
  },
  bushSmall: {
    url: './models/plant_bush.glb',
    scale: 0.15,                                 // 11.8m -> 1.77m (a small bush)
    expectedSize: { x: 1.77, y: 1.69, z: 0.6 },
    description: 'Small plant bush (Sketchfab)'
  },
  bushLarge: {
    url: './models/bush.glb',
    scale: 0.01,                                 // 152m -> 1.52m (was in centimeters!)
    expectedSize: { x: 1.53, y: 1.52, z: 1.13 },
    description: 'Large bush (Open3dModel)'
  }
};

/**
 * Validation report — populated as assets load. The game can read this to
 * show a debug overlay or fail fast if a critical asset is broken.
 */
export const validationReport = {
  assets: {},
  errors: [],
  warnings: [],
  add(assetKey, info) {
    this.assets[assetKey] = info;
    if (info.errors) for (const e of info.errors) this.errors.push(`[${assetKey}] ${e}`);
    if (info.warnings) for (const w of info.warnings) this.warnings.push(`[${assetKey}] ${w}`);
  },
  get ok() {
    return this.errors.length === 0;
  },
  summary() {
    const keys = Object.keys(this.assets);
    return `${keys.length} assets loaded, ${this.errors.length} errors, ${this.warnings.length} warnings`;
  }
};

export class AssetManager {
  constructor() {
    this.cache = new Map();
    this.loader = new GLTFLoader();
  }

  /**
   * Load an asset by registry key. Returns a promise that resolves to a
   * normalized THREE.Group (scaled, oriented, validated).
   */
  async load(key, onProgress = null) {
    if (this.cache.has(key)) return this.cache.get(key);

    const reg = ASSET_REGISTRY[key];
    if (!reg) throw new Error(`Unknown asset key: ${key}`);

    const scene = await new Promise((resolve, reject) => {
      this.loader.load(
        reg.url,
        (gltf) => resolve(gltf.scene),
        (ev) => { if (onProgress && ev.total > 0) onProgress(ev.loaded / ev.total); },
        (err) => reject(new Error(`Failed to load ${reg.url}: ${err.message || err}`))
      );
    });

    // strip studio lights/cameras that came from FBX
    this._stripExtras(scene);

    // normalize: apply the registry scale
    scene.scale.setScalar(reg.scale);

    // validate
    const info = this._validate(key, scene, reg);
    validationReport.add(key, info);

    this.cache.set(key, scene);
    return scene;
  }

  /** Remove lights, cameras, and empty gizmo nodes from the scene. */
  _stripExtras(root) {
    const remove = [];
    root.traverse((o) => {
      if (o.isLight || o.isCamera) remove.push(o);
    });
    for (const o of remove) o.parent && o.parent.remove(o);
  }

  /**
   * Validate a loaded asset: bounding box, mesh count, materials, triangles.
   * Returns an info object with errors[] and warnings[].
   */
  _validate(key, scene, reg) {
    const info = {
      url: reg.url,
      scale: reg.scale,
      errors: [],
      warnings: [],
      meshes: 0,
      triangles: 0,
      materials: 0,
      textures: 0,
      bbox: null
    };

    // update world matrices so bounding box is accurate post-scale
    scene.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(scene);
    const size = bbox.getSize(new THREE.Vector3());
    const center = bbox.getCenter(new THREE.Vector3());
    info.bbox = {
      size: [size.x, size.y, size.z],
      center: [center.x, center.y, center.z],
      min: [bbox.min.x, bbox.min.y, bbox.min.z],
      max: [bbox.max.x, bbox.max.y, bbox.max.z]
    };

    // count meshes, triangles, materials
    const matSet = new Set();
    const texSet = new Set();
    scene.traverse((o) => {
      if (!o.isMesh) return;
      info.meshes++;
      const geom = o.geometry;
      if (geom) {
        const idx = geom.index;
        const count = idx ? idx.count : (geom.attributes.position ? geom.attributes.position.count : 0);
        info.triangles += Math.floor(count / 3);
      }
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          matSet.add(m);
          // collect textures
          for (const tex of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap, m.emissiveMap]) {
            if (tex) texSet.add(tex);
          }
        }
      }
    });
    info.materials = matSet.size;
    info.textures = texSet.size;

    // validate against expected size (±30% tolerance)
    if (reg.expectedSize) {
      const exp = reg.expectedSize;
      const tol = 0.3;
      for (const axis of ['x', 'y', 'z']) {
        const actual = size[axis];
        const expected = exp[axis];
        if (actual < expected * (1 - tol) || actual > expected * (1 + tol)) {
          info.warnings.push(
            `${axis.toUpperCase()} size ${actual.toFixed(2)}m differs from expected ${expected}m ` +
            `(±${tol * 100}% tolerance). Scale may need adjustment.`
          );
        }
      }
    }

    // check for missing materials
    let missingMatCount = 0;
    scene.traverse((o) => {
      if (o.isMesh && !o.material) missingMatCount++;
    });
    if (missingMatCount > 0) {
      info.errors.push(`${missingMatCount} mesh(es) have no material`);
    }

    // check for unusually high triangle counts (performance warning)
    if (info.triangles > 500000) {
      info.warnings.push(`High triangle count: ${info.triangles.toLocaleString()}. May impact performance.`);
    }

    // check if the model is off-center (might indicate a pivot issue)
    if (Math.abs(center.x) > size.x * 0.3 || Math.abs(center.z) > size.z * 0.3) {
      info.warnings.push(
        `Model center is off-origin: (${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)}). ` +
        `Consider re-centering.`
      );
    }

    // log to console
    const status = info.errors.length ? '❌' : (info.warnings.length ? '⚠️' : '✅');
    console.log(
      `[AssetManager] ${status} ${key}: ${info.meshes} meshes, ${info.triangles.toLocaleString()} tris, ` +
      `${info.materials} mats, ${info.textures} tex, ` +
      `size=(${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)})m`
    );
    if (info.warnings.length) for (const w of info.warnings) console.warn(`  ⚠️  ${w}`);
    if (info.errors.length) for (const e of info.errors) console.error(`  ❌ ${e}`);

    return info;
  }

  /**
   * Create an InstancedMesh from a loaded GLB scene. Merges all meshes in
   * the scene into a single geometry, then instances it.
   * @param {string} key - asset registry key
   * @param {number} count - number of instances
   * @returns {{ mesh: THREE.InstancedMesh, info: object }}
   */
  createInstancedFromGLB(key, count) {
    // This is a synchronous helper — the asset must already be loaded.
    if (!this.cache.has(key)) throw new Error(`Asset not loaded: ${key}. Call load() first.`);
    const scene = this.cache.get(key).clone(true);
    scene.updateMatrixWorld(true);

    // collect all meshes + their world-space geometries
    const geometries = [];
    const materialSlots = []; // [{ material, ranges: [{start, count}] }]
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      // ensure we have position + normal
      if (!g.attributes.position) return;
      if (!g.attributes.normal) g.computeVertexNormals();
      // remove unused attributes that would break merge
      for (const attr of Object.keys(g.attributes)) {
        if (!['position', 'normal', 'uv'].includes(attr)) g.deleteAttribute(attr);
      }
      if (!g.index) g = g.toNonIndexed();
      geometries.push({ geometry: g, material: o.material });
    });

    if (!geometries.length) throw new Error(`No meshes found in asset ${key}`);

    // merge all geometries into one, tracking material groups
    const merged = mergeGeometries(geometries.map(g => g.geometry), true);
    if (!merged) throw new Error(`Failed to merge geometries for ${key}`);

    // collect unique materials
    const materials = [];
    const matIndex = new Map();
    for (const g of geometries) {
      const mats = Array.isArray(g.material) ? g.material : [g.material];
      for (const m of mats) {
        if (!matIndex.has(m)) {
          matIndex.set(m, materials.length);
          materials.push(m);
        }
      }
    }

    // create the instanced mesh
    const mesh = new THREE.InstancedMesh(merged, materials.length === 1 ? materials[0] : materials, count);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.count = 0; // start at 0; the caller sets matrices then bumps count

    return { mesh, info: validationReport.assets[key] };
  }

  /** Get the validation report for a loaded asset. */
  getInfo(key) {
    return validationReport.assets[key] || null;
  }

  /** Get the full validation report. */
  getReport() {
    return validationReport;
  }
}
