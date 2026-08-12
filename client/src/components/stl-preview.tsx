import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type StlPreviewProps = {
  file: File | null;
  label?: string;
  className?: string;
  canvasClassName?: string;
  emptyHint?: string;
};

type ViewportTheme = {
  background: number;
  mesh: number;
  meshEmissive: number;
  gridMajor: number;
  gridMinor: number;
  hemiSky: number;
  hemiGround: number;
  key: number;
  fill: number;
  rim: number;
};

/** Chitubox-like slicer viewport: cool slate stage, resin-tinted mesh, readable in both themes. */
function viewportTheme(dark: boolean): ViewportTheme {
  if (dark) {
    return {
      background: 0x2a2e36,
      mesh: 0x7d8b7a,
      meshEmissive: 0x1a221c,
      gridMajor: 0x4a5563,
      gridMinor: 0x353b45,
      hemiSky: 0xd7dde6,
      hemiGround: 0x3a404a,
      key: 0xffffff,
      fill: 0xb8c4d4,
      rim: 0x9eb6ff,
    };
  }
  return {
    background: 0xdce3eb,
    mesh: 0x4f6b5c,
    meshEmissive: 0x0e1612,
    gridMajor: 0x9aa8b8,
    gridMinor: 0xc0c9d4,
    hemiSky: 0xffffff,
    hemiGround: 0xb7c0cc,
    key: 0xffffff,
    fill: 0xd5dee8,
    rim: 0x6d8cff,
  };
}

function isDarkTheme(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

/** Frame the mesh so it fills most of the viewport without clipping. */
function frameObject(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  box: THREE.Box3,
) {
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z, 1);
  const fov = camera.fov * (Math.PI / 180);
  const fitHeight = maxDim / 2 / Math.tan(fov / 2);
  const fitWidth = fitHeight / Math.max(camera.aspect, 0.01);
  const distance = Math.max(fitHeight, fitWidth) * 1.18;
  camera.near = Math.max(distance / 100, 0.01);
  camera.far = distance * 100;
  camera.position.set(distance * 0.72, distance * 0.52, distance * 0.98);
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update();
}

function buildFloorGrid(size: number, theme: ViewportTheme): THREE.Group {
  const group = new THREE.Group();
  group.name = "slicer-grid";

  const major = new THREE.GridHelper(size, 10, theme.gridMajor, theme.gridMinor);
  major.material.transparent = true;
  if (Array.isArray(major.material)) {
    for (const mat of major.material) {
      mat.transparent = true;
      mat.opacity = 0.9;
      mat.depthWrite = false;
    }
  } else {
    major.material.opacity = 0.9;
    major.material.depthWrite = false;
  }
  group.add(major);

  const fine = new THREE.GridHelper(size, 50, theme.gridMinor, theme.gridMinor);
  fine.material.transparent = true;
  if (Array.isArray(fine.material)) {
    for (const mat of fine.material) {
      mat.transparent = true;
      mat.opacity = 0.35;
      mat.depthWrite = false;
    }
  } else {
    fine.material.opacity = 0.35;
    fine.material.depthWrite = false;
  }
  group.add(fine);

  return group;
}

/**
 * Browser-local STL viewer. Loads one File at a time (no server upload).
 * Viewport styling is intentionally slicer-like (Chitubox-adjacent).
 */
export function StlPreview({ file, label, className, canvasClassName, emptyHint }: StlPreviewProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !file) {
      setStatus("idle");
      setError(null);
      return;
    }

    let disposed = false;
    setStatus("loading");
    setError(null);

    const width = Math.max(mount.clientWidth, 1);
    const height = Math.max(mount.clientHeight, 1);
    let theme = viewportTheme(isDarkTheme());

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(theme.background);
    scene.fog = new THREE.Fog(theme.background, 80, 420);

    const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 5000);
    camera.position.set(80, 60, 100);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    mount.replaceChildren(renderer.domElement);

    const hemi = new THREE.HemisphereLight(theme.hemiSky, theme.hemiGround, 0.85);
    scene.add(hemi);

    const key = new THREE.DirectionalLight(theme.key, 1.05);
    key.position.set(55, 90, 40);
    scene.add(key);

    const fill = new THREE.DirectionalLight(theme.fill, 0.45);
    fill.position.set(-60, 30, -20);
    scene.add(fill);

    const rim = new THREE.DirectionalLight(theme.rim, 0.35);
    rim.position.set(10, 25, -70);
    scene.add(rim);

    let grid: THREE.Group | null = null;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.49;

    const loader = new STLLoader();
    let mesh: THREE.Mesh | null = null;
    let meshBox: THREE.Box3 | null = null;
    let frame = 0;

    const placeGrid = (box: THREE.Box3) => {
      if (grid) {
        scene.remove(grid);
        grid.traverse((obj) => {
          if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
            obj.geometry.dispose();
            const mat = obj.material;
            if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
            else mat.dispose();
          }
        });
        grid = null;
      }
      const size = new THREE.Vector3();
      box.getSize(size);
      const maxDim = Math.max(size.x, size.y, size.z, 1);
      const gridSize = Math.max(maxDim * 3.2, 40);
      grid = buildFloorGrid(gridSize, theme);
      // Sit the floor under the part (geometry is centered at origin).
      grid.position.y = -size.y / 2 - maxDim * 0.02;
      scene.add(grid);

      const near = Math.max(maxDim * 2.2, 20);
      const far = Math.max(maxDim * 18, near * 4);
      scene.fog = new THREE.Fog(theme.background, near, far);
    };

    const applyTheme = (next: ViewportTheme) => {
      theme = next;
      scene.background = new THREE.Color(theme.background);
      if (scene.fog instanceof THREE.Fog) scene.fog.color.set(theme.background);
      hemi.color.set(theme.hemiSky);
      hemi.groundColor.set(theme.hemiGround);
      key.color.set(theme.key);
      fill.color.set(theme.fill);
      rim.color.set(theme.rim);
      if (mesh) {
        const material = mesh.material as THREE.MeshStandardMaterial;
        material.color.set(theme.mesh);
        material.emissive.set(theme.meshEmissive);
        material.needsUpdate = true;
      }
      if (meshBox) placeGrid(meshBox);
    };

    const syncSize = (reframe = false) => {
      if (!mountRef.current) return;
      const w = Math.max(mountRef.current.clientWidth, 1);
      const h = Math.max(mountRef.current.clientHeight, 1);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      if (reframe && meshBox) frameObject(camera, controls, meshBox);
    };

    const animate = () => {
      if (disposed) return;
      frame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };

    const onWindowResize = () => syncSize(false);
    const resizeObserver =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => syncSize(false)) : null;
    resizeObserver?.observe(mount);
    window.addEventListener("resize", onWindowResize);

    const themeObserver =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => applyTheme(viewportTheme(isDarkTheme())))
        : null;
    themeObserver?.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    animate();

    file
      .arrayBuffer()
      .then((buffer) => {
        if (disposed) return;
        const geometry = loader.parse(buffer);
        geometry.computeVertexNormals();
        geometry.center();

        const material = new THREE.MeshStandardMaterial({
          color: theme.mesh,
          emissive: theme.meshEmissive,
          emissiveIntensity: 0.22,
          metalness: 0.08,
          roughness: 0.62,
        });
        mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);

        geometry.computeBoundingBox();
        meshBox = geometry.boundingBox ? geometry.boundingBox.clone() : null;
        if (meshBox) placeGrid(meshBox);
        syncSize(true);

        setStatus("ready");
      })
      .catch((err) => {
        if (disposed) return;
        setStatus("error");
        setError(err instanceof Error ? err.message : "Could not load STL");
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      window.removeEventListener("resize", onWindowResize);
      controls.dispose();
      if (grid) {
        scene.remove(grid);
        grid.traverse((obj) => {
          if (obj instanceof THREE.Mesh || obj instanceof THREE.LineSegments) {
            obj.geometry.dispose();
            const mat = obj.material;
            if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
            else mat.dispose();
          }
        });
      }
      if (mesh) {
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
        scene.remove(mesh);
      }
      renderer.dispose();
      mount.replaceChildren();
    };
  }, [file]);

  if (!file) {
    return (
      <div
        className={cn(
          "flex h-full min-h-[16rem] items-center justify-center rounded-md border border-dashed border-border bg-muted/30 px-4 text-center text-sm text-muted-foreground",
          className,
        )}
        data-testid="stl-preview-empty"
      >
        {emptyHint || "Select a part with a local STL to preview."}
      </div>
    );
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-border bg-card", className)}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
        <p className="truncate text-xs font-medium">{label || file.name}</p>
        <p className="shrink-0 text-[0.65rem] uppercase tracking-wide text-muted-foreground">Local preview</p>
      </div>
      <div
        className={cn("relative min-h-0 flex-1 bg-[#dce3eb] dark:bg-[#2a2e36]", canvasClassName)}
        ref={mountRef}
        data-testid="stl-preview-canvas"
      >
        {status === "loading" ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background/50 text-sm backdrop-blur-[1px]">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading STL…
          </div>
        ) : null}
        {status === "error" ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center px-4 text-center text-sm text-destructive">
            {error || "Preview failed"}
          </div>
        ) : null}
      </div>
      <p className="shrink-0 border-t border-border px-3 py-2 text-[0.7rem] text-muted-foreground">
        Drag to orbit · scroll to zoom · compare to the physical print · file stays in this tab
      </p>
    </div>
  );
}
