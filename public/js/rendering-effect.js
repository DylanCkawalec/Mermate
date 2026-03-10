import * as THREE from '/vendor/three/build/three.module.js';

const DEFAULT_WIDTH = 260;
const DEFAULT_HEIGHT = 150;
const CORE_POINTS = 96;
const SPARK_POINTS = 18;

export class RenderWaitingEffect {
  constructor(container, options = {}) {
    this.container = container;
    this.width = options.width || DEFAULT_WIDTH;
    this.height = options.height || DEFAULT_HEIGHT;
    this.startTime = performance.now();
    this.rafId = 0;
    this.disposed = false;
    this.pathColor = new THREE.Color();
    this.sparkColor = new THREE.Color();

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, this.width / this.height, 0.1, 100);
    this.camera.position.set(0, 0, 11.5);

    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
      premultipliedAlpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);

    this.root = new THREE.Group();
    this.root.rotation.x = 0.34;
    this.root.rotation.y = -0.24;
    this.scene.add(this.root);

    this.pathGeometry = new THREE.BufferGeometry();
    this.pathPositions = new Float32Array(CORE_POINTS * 3);
    this.pathColors = new Float32Array(CORE_POINTS * 3);
    this.pathGeometry.setAttribute('position', new THREE.BufferAttribute(this.pathPositions, 3));
    this.pathGeometry.setAttribute('color', new THREE.BufferAttribute(this.pathColors, 3));
    this.pathMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.75,
      blending: THREE.NormalBlending,
    });
    this.path = new THREE.LineLoop(this.pathGeometry, this.pathMaterial);
    this.root.add(this.path);

    this.sparkGeometry = new THREE.BufferGeometry();
    this.sparkPositions = new Float32Array(SPARK_POINTS * 3);
    this.sparkColors = new Float32Array(SPARK_POINTS * 3);
    this.sparkGeometry.setAttribute('position', new THREE.BufferAttribute(this.sparkPositions, 3));
    this.sparkGeometry.setAttribute('color', new THREE.BufferAttribute(this.sparkColors, 3));
    this.sparkMaterial = new THREE.PointsMaterial({
      size: 0.28,
      transparent: true,
      opacity: 0.9,
      vertexColors: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.sparks = new THREE.Points(this.sparkGeometry, this.sparkMaterial);
    this.root.add(this.sparks);

    this.container.replaceChildren(this.renderer.domElement);
    this.resize();
    this.animate = this.animate.bind(this);
    this.animate();
  }

  resize() {
    const width = Math.max(1, this.container.clientWidth || this.width);
    const height = Math.max(1, this.container.clientHeight || this.height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  animate() {
    if (this.disposed) return;
    this.rafId = window.requestAnimationFrame(this.animate);

    const time = (performance.now() - this.startTime) / 1000;
    this.root.rotation.z = time * 0.12;

    for (let i = 0; i < CORE_POINTS; i += 1) {
      const u = i / CORE_POINTS;
      const angle = u * Math.PI * 2;
      const orbit = 2.1 + 0.24 * Math.sin(angle * 3 - time * 1.2);
      const wave = 0.65 * Math.sin(angle * 2 + time * 0.75);
      const taper = 0.84 + 0.12 * Math.cos(angle * 4 - time * 0.4);

      const x = Math.cos(angle) * orbit;
      const y = Math.sin(angle) * orbit * 0.46 + wave * 0.28;
      const z = 1.2 * Math.sin(angle * 1.5 - time * 0.55) * taper;

      const blend = 0.5 + 0.5 * Math.sin(angle * 2 + time * 0.5);
      const color = this.pathColor.setHSL(
        0.63 + 0.06 * blend,
        0.55 + 0.2 * blend,
        0.42 + 0.12 * blend
      );

      const offset = i * 3;
      this.pathPositions[offset] = x;
      this.pathPositions[offset + 1] = y;
      this.pathPositions[offset + 2] = z;
      this.pathColors[offset] = color.r;
      this.pathColors[offset + 1] = color.g;
      this.pathColors[offset + 2] = color.b;
    }

    for (let i = 0; i < SPARK_POINTS; i += 1) {
      const t = time * 0.9 + i * 0.34;
      const radius = 0.55 + ((i * 17) % 23) * 0.11;
      const x = Math.cos(t * 1.8) * radius * 1.45;
      const y = Math.sin(t * 1.4 + i) * radius * 0.52;
      const z = Math.cos(t * 1.2 - i * 0.45) * radius;

      const glow = 0.5 + 0.5 * Math.sin(time * 1.7 + i * 0.8);
      const sparkColor = this.sparkColor.setHSL(0.08 + glow * 0.04, 0.7, 0.52 + 0.1 * glow);

      const offset = i * 3;
      this.sparkPositions[offset] = x;
      this.sparkPositions[offset + 1] = y;
      this.sparkPositions[offset + 2] = z;
      this.sparkColors[offset] = sparkColor.r;
      this.sparkColors[offset + 1] = sparkColor.g;
      this.sparkColors[offset + 2] = sparkColor.b;
    }

    this.pathGeometry.attributes.position.needsUpdate = true;
    this.pathGeometry.attributes.color.needsUpdate = true;
    this.sparkGeometry.attributes.position.needsUpdate = true;
    this.sparkGeometry.attributes.color.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    window.cancelAnimationFrame(this.rafId);
    this.pathGeometry.dispose();
    this.pathMaterial.dispose();
    this.sparkGeometry.dispose();
    this.sparkMaterial.dispose();
    this.renderer.dispose();
    this.container.replaceChildren();
  }
}
