import type { Material, Mesh } from "three";

/** Drag to rotate, scroll or pinch to zoom. three.js loads only when this runs. */
export async function mountPlateModel(host: HTMLElement, url: string, fileName: string): Promise<() => void> {
  const THREE = await import("three");
  const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
  const lower = fileName.toLowerCase();
  const root = new THREE.Group();
  if (lower.endsWith(".3mf")) {
    const { ThreeMFLoader } = await import("three/examples/jsm/loaders/3MFLoader.js");
    root.add(await new ThreeMFLoader().loadAsync(url));
  } else {
    const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
    const geometry = await new STLLoader().loadAsync(url);
    geometry.computeVertexNormals();
    root.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xc4b8a5, metalness: 0.08, roughness: 0.62 })));
  }

  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  root.position.sub(center);
  const maxDim = Math.max(size.x, size.y, size.z, 0.001);
  root.scale.setScalar(1.6 / maxDim);

  const canvas = document.createElement("canvas");
  host.replaceChildren(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
  camera.position.set(1.4, 1.05, 1.8);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.rotateSpeed = 0.85;
  const ambient = new THREE.AmbientLight(0xffffff, 0.72);
  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(2.2, 3.4, 2.6);
  scene.add(ambient, key, root);

  const resize = () => {
    const width = host.clientWidth || 320;
    const height = host.clientHeight || 240;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
  };
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  let frame = 0;
  const tick = () => {
    frame = window.requestAnimationFrame(tick);
    controls.update();
    renderer.render(scene, camera);
  };
  tick();

  return () => {
    window.cancelAnimationFrame(frame);
    observer.disconnect();
    controls.dispose();
    renderer.dispose();
    root.traverse((node) => {
      const mesh = node as Mesh;
      mesh.geometry?.dispose();
      const material = mesh.material as Material | Material[] | undefined;
      if (Array.isArray(material)) {
        for (const item of material) item.dispose();
      } else if (material) {
        material.dispose();
      }
    });
    canvas.remove();
  };
}
