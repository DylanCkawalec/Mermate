import * as THREE from '/vendor/three/build/three.module.js';

const DEFAULT_SIZE = 25;
const PATH_POINTS = 72;
const NODE_POINTS = 12;

export class AgentThinkingEffect {
  constructor(container, options = {}) {
    this.container = container;
    this.size = options.size || DEFAULT_SIZE;
    this.startTime = performance.now();
    this.rafId = 0;
    this.disposed = false;
    this.pathColor = new THREE.Color();
    this.nodeColor = new THREE.Color();

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
    this.camera.position.set(0, 0, 8.5);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
      premultipliedAlpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);

    this.pathGeometry = new THREE.BufferGeometry();
    this.pathPositions = new Float32Array(PATH_POINTS * 3);
    this.pathColors = new Float32Array(PATH_POINTS * 3);
    this.pathGeometry.setAttribute('position', new THREE.BufferAttribute(this.pathPositions, 3));
    this.pathGeometry.setAttribute('color', new THREE.BufferAttribute(this.pathColors, 3));

    this.pathMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.7,
      blending: THREE.NormalBlending,
    });
    this.path = new THREE.LineLoop(this.pathGeometry, this.pathMaterial);
    this.root.add(this.path);

    this.nodeGeometry = new THREE.BufferGeometry();
    this.nodePositions = new Float32Array(NODE_POINTS * 3);
    this.nodeColors = new Float32Array(NODE_POINTS * 3);
    this.nodeGeometry.setAttribute('position', new THREE.BufferAttribute(this.nodePositions, 3));
    this.nodeGeometry.setAttribute('color', new THREE.BufferAttribute(this.nodeColors, 3));

    this.nodeMaterial = new THREE.PointsMaterial({
      size: 0.38,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.85,
      vertexColors: true,
      blending: THREE.NormalBlending,
      depthWrite: false,
    });
    this.nodes = new THREE.Points(this.nodeGeometry, this.nodeMaterial);
    this.root.add(this.nodes);

    this.container.replaceChildren(this.renderer.domElement);
    this.resize();
    this.animate = this.animate.bind(this);
    this.animate();
  }

  resize() {
    const width = Math.max(1, this.container.clientWidth || this.size);
    const height = Math.max(1, this.container.clientHeight || this.size);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  animate() {
    if (this.disposed) return;
    this.rafId = window.requestAnimationFrame(this.animate);

    const time = (performance.now() - this.startTime) / 1000;
    const wobble = Math.sin(time * 0.28) * 0.18;
    this.root.rotation.x = 0.42 + Math.sin(time * 0.12) * 0.08;
    this.root.rotation.y = -0.3 + Math.cos(time * 0.09) * 0.1;
    this.root.rotation.z = time * 0.09;

    for (let i = 0; i < PATH_POINTS; i += 1) {
      const u = i / PATH_POINTS;
      const angle = u * Math.PI * 2;
      const radius = 1.38
        + 0.2 * Math.sin(angle * 3 - time * 0.45)
        + 0.1 * Math.cos(angle * 5 + time * 0.32);
      const lift = 0.58 * Math.sin(angle * 2 + time * 0.22)
        + 0.14 * Math.cos(angle * 4 - time * 0.14);

      const x = Math.cos(angle + wobble) * radius;
      const y = Math.sin(angle - wobble * 0.6) * (0.86 + 0.08 * Math.cos(time * 0.16)) + lift * 0.15;
      const z = 0.42 * Math.cos(angle * 3 - time * 0.2) + lift * 0.45;

      const blend = 0.5 + 0.5 * Math.sin(angle * 2 + time * 0.18);
      const color = this.pathColor.setHSL(0, 0, 0.12 + 0.08 * blend);

      const offset = i * 3;
      this.pathPositions[offset] = x;
      this.pathPositions[offset + 1] = y;
      this.pathPositions[offset + 2] = z;
      this.pathColors[offset] = color.r;
      this.pathColors[offset + 1] = color.g;
      this.pathColors[offset + 2] = color.b;
    }

    for (let i = 0; i < NODE_POINTS; i += 1) {
      const sourceIndex = ((i * 6) + Math.floor(time * 1.1)) % PATH_POINTS;
      const sourceOffset = sourceIndex * 3;
      const targetOffset = i * 3;

      this.nodePositions[targetOffset] = this.pathPositions[sourceOffset];
      this.nodePositions[targetOffset + 1] = this.pathPositions[sourceOffset + 1];
      this.nodePositions[targetOffset + 2] = this.pathPositions[sourceOffset + 2];

      const pulse = 0.52 + 0.48 * Math.sin(time * 0.68 + i * 0.8);
      const nodeColor = this.nodeColor.setHSL(0, 0, 0.08 + 0.1 * pulse);
      this.nodeColors[targetOffset] = nodeColor.r;
      this.nodeColors[targetOffset + 1] = nodeColor.g;
      this.nodeColors[targetOffset + 2] = nodeColor.b;
    }

    this.pathGeometry.attributes.position.needsUpdate = true;
    this.pathGeometry.attributes.color.needsUpdate = true;
    this.nodeGeometry.attributes.position.needsUpdate = true;
    this.nodeGeometry.attributes.color.needsUpdate = true;

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    window.cancelAnimationFrame(this.rafId);
    this.pathGeometry.dispose();
    this.pathMaterial.dispose();
    this.nodeGeometry.dispose();
    this.nodeMaterial.dispose();
    this.renderer.dispose();
    this.container.replaceChildren();
  }
}
