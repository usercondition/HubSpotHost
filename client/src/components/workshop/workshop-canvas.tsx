import { Canvas } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import * as THREE from "three";
import { WorkshopScene } from "@/components/workshop/workshop-scene";
import type { WorkshopCanvasProps } from "@/lib/workshop-types";

export default function WorkshopCanvas(props: WorkshopCanvasProps) {
  const { dark, reduceMotion } = props;
  return (
    <Canvas
      className="workshop-canvas"
      dpr={[1, 1.5]}
      gl={{
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
        stencil: false,
      }}
      camera={{ position: [8.4, 7.2, 8.6], fov: 30, near: 0.2, far: 60 }}
      frameloop={reduceMotion ? "demand" : "always"}
      onCreated={({ gl }) => {
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = dark ? 0.88 : 1.05;
        gl.setClearColor(dark ? "#12100e" : "#ebe4da", 1);
      }}
      onPointerMissed={() => props.onHover(null)}
    >
      <WorkshopScene {...props} />
      <OrbitControls
        makeDefault
        enablePan={false}
        enableDamping={!reduceMotion}
        dampingFactor={0.08}
        autoRotate={!reduceMotion}
        autoRotateSpeed={0.22}
        minPolarAngle={0.55}
        maxPolarAngle={1.15}
        minDistance={9}
        maxDistance={16}
        target={[0, 0.35, 0]}
      />
    </Canvas>
  );
}
