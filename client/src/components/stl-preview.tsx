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

function sceneBackgroundColor(): number {
  if (typeof document === "undefined") return 0xe7e5e4;
  return document.documentElement.classList.contains("dark") ? 0x1c1917 : 0xe7e5e4;
}

function meshColor(): number {
  if (typeof document === "undefined") return 0x57534e;
  return document.documentElement.classList.contains("dark") ? 0xa8a29e : 0x57534e;
}

/**
 * Browser-local STL viewer. Loads one File at a time (no server upload).
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

    const width = mount.clientWidth || 320;
    const height = mount.clientHeight || 240;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(sceneBackgroundColor());

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 5000);
    camera.position.set(80, 60, 100);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    mount.replaceChildren(renderer.domElement);

    const hemi = new THREE.HemisphereLight(0xffffff, 0xb0b0b0, 1.1);
    scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.85);
    dir.position.set(40, 80, 30);
    scene.add(dir);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;

    const loader = new STLLoader();
    let mesh: THREE.Mesh | null = null;
    let frame = 0;

    const animate = () => {
      if (disposed) return;
      frame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };

    const onResize = () => {
      if (!mountRef.current) return;
      const w = mountRef.current.clientWidth || width;
      const h = mountRef.current.clientHeight || height;
      camera.aspect = w / Math.max(h, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };

    window.addEventListener("resize", onResize);
    animate();

    file
      .arrayBuffer()
      .then((buffer) => {
        if (disposed) return;
        const geometry = loader.parse(buffer);
        geometry.computeVertexNormals();
        geometry.center();

        const material = new THREE.MeshStandardMaterial({
          color: meshColor(),
          metalness: 0.12,
          roughness: 0.58,
        });
        mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);

        geometry.computeBoundingBox();
        const box = geometry.boundingBox;
        if (box) {
          const size = new THREE.Vector3();
          box.getSize(size);
          const maxDim = Math.max(size.x, size.y, size.z, 1);
          const dist = maxDim * 2.2;
          camera.position.set(dist, dist * 0.75, dist);
          controls.target.set(0, 0, 0);
          controls.update();
        }

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
      window.removeEventListener("resize", onResize);
      controls.dispose();
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
          "flex min-h-[14rem] items-center justify-center rounded-md border border-dashed border-border bg-muted/25 px-4 text-center text-sm text-muted-foreground",
          className,
        )}
        data-testid="stl-preview-empty"
      >
        {emptyHint || "Select a part with a local STL to preview."}
      </div>
    );
  }

  return (
    <div className={cn("overflow-hidden rounded-md border border-border bg-card", className)}>
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <p className="truncate text-xs font-medium">{label || file.name}</p>
        <p className="shrink-0 text-[0.65rem] uppercase tracking-wide text-muted-foreground">Local preview</p>
      </div>
      <div
        className={cn("relative bg-muted/40", canvasClassName || "h-56")}
        ref={mountRef}
        data-testid="stl-preview-canvas"
      >
        {status === "loading" ? (
          <div className="absolute inset-0 flex items-center justify-center gap-2 bg-background/40 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading STL…
          </div>
        ) : null}
        {status === "error" ? (
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-destructive">
            {error || "Preview failed"}
          </div>
        ) : null}
      </div>
      <p className="px-3 py-2 text-[0.7rem] text-muted-foreground">
        Drag to orbit · scroll to zoom · compare to the physical print · file stays in this tab
      </p>
    </div>
  );
}
