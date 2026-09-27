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

  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  const plate = gltf.scene.children[0]?.userData?.plate as [number, number] | undefined;
  const plateW = Math.max(plate?.[0] ?? box.max.x, 1);
  const plateD = Math.max(plate?.[1] ?? box.max.z, 1);
  const focus = new THREE.Vector3(plateW / 2, (box.min.y + box.max.y) / 2, plateD / 2);
  const radius = Math.max(plateW, plateD, size.y, 1);
  camera.near = radius / 200;
  camera.far = radius * 40;
  camera.position.set(focus.x + radius * 0.85, focus.y + radius * 0.7, focus.z + radius * 1.2);
  camera.lookAt(focus);
  camera.updateProjectionMatrix();
  controls.target.copy(focus);
  controls.update();

  const pad = Math.max(radius * 0.03, 0.15);
  const y = box.min.y - Math.max(radius * 0.012, 0.02);
  const outline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-pad, y, -pad),
      new THREE.Vector3(plateW + pad, y, -pad),
      new THREE.Vector3(plateW + pad, y, plateD + pad),
      new THREE.Vector3(-pad, y, plateD + pad),
    ]),
    new THREE.LineBasicMaterial({ color: 0x9aa3b2 }),
  );
  scene.add(outline);
  scene.add(new THREE.AmbientLight(0xffffff, 0.72));
  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(radius, radius * 2, radius);
  scene.add(key);

  let frame = 0;
  const draw = () => {
    frame = requestAnimationFrame(draw);
    controls.update();
    renderer.render(scene, camera);
  };
  draw();

  const resize = () => {
    const nextW = Math.max(1, host.clientWidth);
    const nextH = Math.max(1, host.clientHeight);
    camera.aspect = nextW / nextH;
    camera.updateProjectionMatrix();
    renderer.setSize(nextW, nextH);
  };
  const observer = new ResizeObserver(resize);
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
