/**
 * Library 3D view. three.js is imported here so the Library page does not load it up front.
 */
export async function mountPlateMesh(host: HTMLElement, glb: ArrayBuffer): Promise<() => void> {
  const THREE = await import("three");
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");

  const width = Math.max(1, host.clientWidth);
  const height = Math.max(1, host.clientHeight);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height);
  renderer.setClearColor(0x111111, 1);
  host.replaceChildren(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, width / height, 0.01, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  const loader = new GLTFLoader();
  const gltf = await new Promise<import("three/examples/jsm/loaders/GLTFLoader.js").GLTF>((resolve, reject) => {
    loader.parse(glb, "", resolve, reject);
  });
  scene.add(gltf.scene);

  const meshBox = new THREE.Box3().setFromObject(gltf.scene);
  const plate = gltf.scene.children[0]?.userData?.plate as [number, number] | undefined;
  const plateW = Math.max(plate?.[0] ?? meshBox.max.x, 1);
  const plateD = Math.max(plate?.[1] ?? meshBox.max.z, 1);
  const span = Math.max(plateW, plateD, meshBox.getSize(new THREE.Vector3()).y, 1);
  const pad = Math.max(span * 0.03, 0.15);
  const floorY = meshBox.min.y - Math.max(span * 0.012, 0.02);
  const fit = meshBox.clone();
  fit.expandByPoint(new THREE.Vector3(-pad, floorY, -pad));
  fit.expandByPoint(new THREE.Vector3(plateW + pad, floorY, plateD + pad));
  const outline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-pad, floorY, -pad),
      new THREE.Vector3(plateW + pad, floorY, -pad),
      new THREE.Vector3(plateW + pad, floorY, plateD + pad),
      new THREE.Vector3(-pad, floorY, plateD + pad),
    ]),
    new THREE.LineBasicMaterial({ color: 0x9aa3b2 }),
  );
  scene.add(outline);
  scene.add(new THREE.AmbientLight(0xffffff, 0.72));
  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(span, span * 2, span);
  scene.add(key);

  const center = fit.getCenter(new THREE.Vector3());
  const radius = Math.max(fit.getBoundingSphere(new THREE.Sphere()).radius, 0.5);
  /** Front is +Z. A 3/4 view sits up and to the right of that edge. */
  const view = new THREE.Vector3(0.75, 0.62, 1).normalize();

  const frameCamera = () => {
    const nextW = Math.max(1, host.clientWidth);
    const nextH = Math.max(1, host.clientHeight);
    camera.aspect = nextW / nextH;
    const fovV = (camera.fov * Math.PI) / 180;
    const fovH = 2 * Math.atan(Math.tan(fovV / 2) * camera.aspect);
    const distance = (radius / Math.sin(Math.min(fovV, fovH) / 2)) * 1.22;
    camera.position.copy(center).addScaledVector(view, distance);
    camera.near = Math.max(distance / 200, 0.01);
    camera.far = distance * 8;
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.minDistance = distance * 0.35;
    controls.maxDistance = distance * 4;
    controls.update();
    renderer.setSize(nextW, nextH);
  };
  frameCamera();

  let frame = 0;
  const draw = () => {
    frame = requestAnimationFrame(draw);
    controls.update();
    renderer.render(scene, camera);
  };
  draw();

  const observer = new ResizeObserver(() => frameCamera());
  observer.observe(host);

  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    controls.dispose();
    renderer.dispose();
    outline.geometry.dispose();
    outline.material.dispose();
    gltf.scene.traverse((obj) => {
      const mesh = obj as {
        geometry?: { dispose(): void };
        material?: { dispose(): void } | Array<{ dispose(): void }>;
      };
      mesh.geometry?.dispose();
      const material = mesh.material;
      if (!material) return;
      if (Array.isArray(material)) material.forEach((item) => item.dispose());
      else material.dispose();
    });
    renderer.domElement.remove();
  };
}
