/**
 * Library 3D view. three.js is imported here so the Library page does not load it up front.
 * The camera frames the mesh. The plate outline stays on the floor and does not set the fit.
 */
export async function mountPlateMesh(host: HTMLElement, glb: ArrayBuffer): Promise<{ dispose: () => void; reset: () => void }> {
  const THREE = await import("three");
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  const { MeshoptDecoder } = await import("three/examples/jsm/libs/meshopt_decoder.module.js");
  const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");

  const width = Math.max(1, host.clientWidth);
  const height = Math.max(1, host.clientHeight);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
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
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await new Promise<import("three/examples/jsm/loaders/GLTFLoader.js").GLTF>((resolve, reject) => {
    loader.parse(glb, "", resolve, reject);
  });
  scene.add(gltf.scene);

  const meshBox = new THREE.Box3().setFromObject(gltf.scene);
  const plate = gltf.scene.children[0]?.userData?.plate as [number, number] | undefined;
  const plateW = Math.max(plate?.[0] ?? meshBox.max.x, 1);
  const plateD = Math.max(plate?.[1] ?? meshBox.max.z, 1);
  const size = meshBox.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z, 1);
  const floorY = meshBox.min.y - Math.max(span * 0.012, 0.15);
  const outline = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, floorY, 0),
      new THREE.Vector3(plateW, floorY, 0),
      new THREE.Vector3(plateW, floorY, plateD),
      new THREE.Vector3(0, floorY, plateD),
    ]),
    new THREE.LineBasicMaterial({ color: 0x9aa3b2 }),
  );
  scene.add(outline);
  scene.add(new THREE.AmbientLight(0xffffff, 0.72));
  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(span, span * 2, span);
  scene.add(key);

  const center = meshBox.getCenter(new THREE.Vector3());
  const corners = [
    new THREE.Vector3(meshBox.min.x, meshBox.min.y, meshBox.min.z),
    new THREE.Vector3(meshBox.min.x, meshBox.min.y, meshBox.max.z),
    new THREE.Vector3(meshBox.min.x, meshBox.max.y, meshBox.min.z),
    new THREE.Vector3(meshBox.min.x, meshBox.max.y, meshBox.max.z),
    new THREE.Vector3(meshBox.max.x, meshBox.min.y, meshBox.min.z),
    new THREE.Vector3(meshBox.max.x, meshBox.min.y, meshBox.max.z),
    new THREE.Vector3(meshBox.max.x, meshBox.max.y, meshBox.min.z),
    new THREE.Vector3(meshBox.max.x, meshBox.max.y, meshBox.max.z),
  ];
  /** Front is +Z. A 3/4 view sits up and to the right of that edge. */
  const view = new THREE.Vector3(0.75, 0.62, 1).normalize();
  const fill = 0.8;

  const frameCamera = () => {
    const nextW = Math.max(1, host.clientWidth);
    const nextH = Math.max(1, host.clientHeight);
    camera.aspect = nextW / nextH;
    camera.near = Math.max(span / 1000, 0.01);
    camera.far = Math.max(span * 100, plateW + plateD);
    camera.updateProjectionMatrix();
    const target = center.clone();
    let distance = span * 4;
    const projectBox = () => {
      camera.position.copy(target).addScaledVector(view, distance);
      camera.lookAt(target);
      camera.updateMatrixWorld(true);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const corner of corners) {
        const ndc = corner.clone().project(camera);
        if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y)) return null;
        if (ndc.x < minX) minX = ndc.x;
        if (ndc.x > maxX) maxX = ndc.x;
        if (ndc.y < minY) minY = ndc.y;
        if (ndc.y > maxY) maxY = ndc.y;
      }
      return { minX, maxX, minY, maxY };
    };
    for (let pass = 0; pass < 6; pass += 1) {
      let lo = Math.max(span * 0.02, 0.05);
      let hi = Math.max(span * 80, plateW + plateD);
      for (let step = 0; step < 14; step += 1) {
        distance = (lo + hi) / 2;
        const box = projectBox();
        const spanNdc = box ? Math.max(box.maxX - box.minX, box.maxY - box.minY) : 4;
        if (spanNdc > fill * 2) lo = distance;
        else hi = distance;
      }
      distance = hi;
      const box = projectBox();
      if (!box) break;
      const halfH = Math.tan(((camera.fov * Math.PI) / 180) / 2) * distance;
      const halfW = halfH * camera.aspect;
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      const camUp = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
      target.addScaledVector(right, ((box.minX + box.maxX) / 2) * halfW);
      target.addScaledVector(camUp, ((box.minY + box.maxY) / 2) * halfH);
    }
    const fitted = projectBox();
    if (fitted) {
      const spanNdc = Math.max(fitted.maxX - fitted.minX, fitted.maxY - fitted.minY);
      if (spanNdc > 0.2) distance *= spanNdc / (fill * 2);
    }
    camera.position.copy(target).addScaledVector(view, distance);
    camera.near = Math.max(distance / 200, 0.01);
    camera.far = Math.max(distance * 8, plateW + plateD);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    controls.target.copy(target);
    controls.minDistance = distance * 0.08;
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

  const dispose = () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    controls.dispose();
    renderer.dispose();
    outline.geometry.dispose();
    (outline.material as { dispose(): void }).dispose();
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
  return { dispose, reset: () => frameCamera() };
}
