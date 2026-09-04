/**
 * ModelKit — shared utilities for working with the GLB assets:
 * quantization-safe geometry conversion, plane splitting for the merged
 * axle meshes, and small material helpers.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/**
 * Load a GLB with byte-level progress callback.
 * @returns {Promise<THREE.Group>} the loaded scene
 */
export function loadGLB(url, onProgress) {
  return new Promise((resolve, reject) => {
    new GLTFLoader().load(
      url,
      (gltf) => resolve(gltf.scene),
      (ev) => {
        if (onProgress && ev.total > 0) onProgress(ev.loaded / ev.total);
      },
      (err) => reject(err)
    );
  });
}

/**
 * glTF-transform quantized meshes arrive as normalized int16 attributes with
 * a compensating node transform. String ops (applyMatrix4, splitting) need
 * plain float32 — this dequantizes every attribute once.
 * Returns a NEW non-indexed geometry.
 */
export function toFloat32Geometry(g) {
  const src = g.index ? g.toNonIndexed() : g.clone();
  for (const name of Object.keys(src.attributes)) {
    const attr = src.attributes[name];
    const n = attr.count;
    const item = attr.itemSize;
    const arr = new Float32Array(n * item);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < item; c++) {
        arr[i * item + c] = attr[`get${'XYZW'[c]}`](i);
      }
    }
    src.setAttribute(name, new THREE.BufferAttribute(arr, item));
  }
  return src;
}

/**
 * Extract the triangles of a baked float32 geometry whose vertices pass
 * keep[] (a triangle survives when >= 2 of its 3 vertices pass).
 * Returns null when nothing survives.
 */
export function keepTriangles(src, keep) {
  const pos = src.attributes.position;
  const keepTris = [];
  for (let t = 0; t < pos.count / 3; t++) {
    const a = t * 3;
    const vote = (keep[a] ? 1 : 0) + (keep[a + 1] ? 1 : 0) + (keep[a + 2] ? 1 : 0);
    if (vote >= 2) keepTris.push(t);
  }
  if (!keepTris.length) return null;

  const out = new THREE.BufferGeometry();
  const newCount = keepTris.length * 3;
  for (const name of Object.keys(src.attributes)) {
    const attr = src.attributes[name];
    const item = attr.itemSize;
    const arr = new Float32Array(newCount * item);
    let o = 0;
    for (const t of keepTris) {
      for (let v = 0; v < 3; v++) {
        const i = t * 3 + v;
        for (let c = 0; c < item; c++) arr[o++] = attr.array[i * item + c];
      }
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, item));
  }
  return out;
}

/** Strip lights, cameras and empty gizmo nodes that came along from FBX. */
export function stripExtras(root) {
  const remove = [];
  root.traverse((o) => {
    if (o.isLight || o.isCamera) remove.push(o);
  });
  for (const o of remove) o.parent && o.parent.remove(o);
}

/**
 * Bake each mesh's full transform chain (relative to `frame`) into its
 * geometry — returns the meshes without changing the graph.
 */
export function bakedMeshes(root, frame) {
  const inv = new THREE.Matrix4().copy(frame.matrixWorld).invert();
  root.updateMatrixWorld(true);
  const out = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = toFloat32Geometry(o.geometry);
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld));
    out.push({ mesh: o, geometry: g });
  });
  return out;
}
