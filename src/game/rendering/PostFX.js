/**
 * PostFX — post-processing stack: bloom for headlights, street lamps,
 * neon nights and sun glare. Renders through EffectComposer with an
 * OutputPass handling tone mapping + color space.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export class PostFX {
  constructor(renderer, scene, camera, enabled = true) {
    this.enabled = enabled;
    try {
      this.composer = new EffectComposer(renderer);
      this.composer.addPass(new RenderPass(scene, camera));
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      this.bloom = new UnrealBloomPass(size, 0.42, 0.7, 0.86);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    } catch (e) {
      console.warn('[ApexRoads] PostFX unavailable:', e && e.message);
      this.enabled = false;
      this.composer = null;
    }
  }

  setEnabled(v) {
    this.enabled = !!v && !!this.composer;
    if (this.composer) this.composer.setSize(1, 1); // force realloc on next setSize
  }

  setSize(w, h, pixelRatio) {
    if (!this.composer) return;
    this.composer.setPixelRatio?.(pixelRatio);
    this.composer.setSize(w, h);
  }

  render(renderer, scene, camera) {
    if (this.enabled && this.composer) {
      this.composer.render();
    } else {
      renderer.render(scene, camera);
    }
  }
}
