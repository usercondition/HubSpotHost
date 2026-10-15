import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html, RoundedBox } from "@react-three/drei";
import * as THREE from "three";
import { shopDateLabel, shipByCalendarDate } from "@shared/ship-by";
import { orderTitle } from "@/lib/order-title";
import {
  groupOrdersByStation,
  WORKSHOP_STATIONS,
  type WorkshopStationId,
} from "@/lib/workshop-stations";
import type { WorkshopCanvasProps, WorkshopHover } from "@/lib/workshop-types";
import type { ProductionQueueItem } from "@shared/schema";

const STATION_POSE: Record<WorkshopStationId, [number, number, number]> = {
  intake: [0.05, 0, 2.05],
  print: [-3.2, 0, 0.1],
  wash: [-1.2, 0, -1.85],
  qa: [1.3, 0, -1.85],
  pack: [3.25, 0, 0.2],
};

type Palette = {
  void: string;
  fog: string;
  slab: string;
  slabEdge: string;
  wall: string;
  peg: string;
  wood: string;
  woodDark: string;
  metal: string;
  printer: string;
  screenIdle: string;
  uv: string;
  wash: string;
  lamp: string;
  token: string;
  tokenDue: string;
  tokenOverdue: string;
  paper: string;
  label: string;
};

function palette(dark: boolean): Palette {
  if (dark) {
    return {
      void: "#1a1612",
      fog: "#241e18",
      slab: "#6a5d50",
      slabEdge: "#4e443a",
      wall: "#5a5148",
      peg: "#7a6e62",
      wood: "#8a6a4e",
      woodDark: "#5c4636",
      metal: "#5a5652",
      printer: "#3d3a38",
      screenIdle: "#1c1824",
      uv: "#9b88ff",
      wash: "#4e5c64",
      lamp: "#f0c27a",
      token: "#e0a45a",
      tokenDue: "#f0c27a",
      tokenOverdue: "#d46a48",
      paper: "#e6d6c2",
      label: "#f3e6d4",
    };
  }
  return {
    void: "#ebe4da",
    fog: "#e4ddd3",
    slab: "#d4cbc0",
    slabEdge: "#c2b7aa",
    wall: "#cfc6ba",
    peg: "#b7aa9c",
    wood: "#b08968",
    woodDark: "#8d6b4f",
    metal: "#9a9590",
    printer: "#8f8a84",
    screenIdle: "#2a2430",
    uv: "#7b6cff",
    wash: "#7d8b90",
    lamp: "#f4d19a",
    token: "#d4923a",
    tokenDue: "#e8b56a",
    tokenOverdue: "#c45c3a",
    paper: "#f4eee6",
    label: "#3f382f",
  };
}

function clay(color: string, extras?: { emissive?: string; emissiveIntensity?: number }) {
  return (
    <meshStandardMaterial
      color={color}
      roughness={0.94}
      metalness={0.03}
      emissive={extras?.emissive ?? "#000000"}
      emissiveIntensity={extras?.emissiveIntensity ?? 0}
    />
  );
}

function tokenOffset(index: number, count: number): [number, number, number] {
  const cols = Math.min(3, Math.max(count, 1));
  const col = index % cols;
  const row = Math.floor(index / cols);
  const x = (col - (cols - 1) / 2) * 0.4;
  const z = row * 0.38;
  return [x, 0, z];
}

function tokenColor(order: ProductionQueueItem, today: string, colors: Palette): string {
  if (order.shipBy < today) return colors.tokenOverdue;
  if (order.shipBy === today) return colors.tokenDue;
  return colors.token;
}

function ResinToken({
  order,
  position,
  selected,
  colors,
  today,
  dark,
  reduceMotion,
  onHover,
  onSelect,
}: {
  order: ProductionQueueItem;
  position: [number, number, number];
  selected: boolean;
  colors: Palette;
  today: string;
  dark: boolean;
  reduceMotion: boolean;
  onHover: (hover: WorkshopHover | null) => void;
  onSelect: (dealId: string) => void;
}) {
  const group = useRef<THREE.Group>(null);
  const color = tokenColor(order, today, colors);
  const name = orderTitle(order.dealName, order.contactName);
  const shipLabel = shopDateLabel({
    date: order.shipBy,
    today,
    source: order.shipBySource === "override" ? "override" : "derived",
    tentative: order.tentative,
  });

  useFrame((state) => {
    if (!group.current || reduceMotion) return;
    const t = state.clock.elapsedTime;
    group.current.position.y = position[1] + Math.sin(t * 0.9 + position[0]) * 0.012;
  });

  return (
    <group
      ref={group}
      position={position}
      onPointerOver={(event) => {
        event.stopPropagation();
        onHover({
          dealId: order.dealId,
          name,
          shipBy: shipLabel,
          station: "intake",
        });
      }}
      onPointerOut={(event) => {
        event.stopPropagation();
        onHover(null);
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect(order.dealId);
      }}
    >
      <mesh position={[0, 0.2, 0]}>
        <sphereGeometry args={[0.32, 10, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0.03, 0]} castShadow={false}>
        <cylinderGeometry args={[0.13, 0.15, 0.05, 10]} />
        {clay(colors.woodDark)}
      </mesh>
      <mesh position={[0, 0.16, 0.01]}>
        <boxGeometry args={[0.13, 0.2, 0.1]} />
        {clay(color, { emissive: color, emissiveIntensity: selected ? 0.28 : dark ? 0.12 : 0.05 })}
      </mesh>
      <mesh position={[0, 0.32, 0.01]}>
        <sphereGeometry args={[0.075, 12, 10]} />
        {clay(color, { emissive: color, emissiveIntensity: selected ? 0.28 : dark ? 0.12 : 0.05 })}
      </mesh>
      {selected ? (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.18, 0.22, 24]} />
          <meshBasicMaterial color={colors.lamp} transparent opacity={0.85} />
        </mesh>
      ) : null}
    </group>
  );
}

function ResinPrinter({
  position,
  printing,
  reduceMotion,
  colors,
  dark,
}: {
  position: [number, number, number];
  printing: boolean;
  reduceMotion: boolean;
  colors: Palette;
  dark: boolean;
}) {
  const plate = useRef<THREE.Mesh>(null);
  useFrame((state) => {
    if (!plate.current) return;
    if (!printing || reduceMotion) {
      plate.current.position.y = printing ? 0.34 : 0.16;
      return;
    }
    const t = (Math.sin(state.clock.elapsedTime * 0.32) + 1) / 2;
    plate.current.position.y = 0.16 + t * 0.26;
  });

  const glow = printing ? (dark ? 3.4 : 1.6) : dark ? 0.45 : 0.12;

  return (
    <group position={position}>
      <RoundedBox args={[0.62, 0.08, 0.5]} radius={0.03} smoothness={3} position={[0, 0.04, 0]}>
        {clay(colors.metal)}
      </RoundedBox>
      <RoundedBox args={[0.52, 0.62, 0.08]} radius={0.02} smoothness={3} position={[0, 0.38, -0.2]}>
        {clay(colors.printer)}
      </RoundedBox>
      <RoundedBox args={[0.08, 0.62, 0.42]} radius={0.02} smoothness={3} position={[-0.24, 0.38, 0.02]}>
        {clay(colors.printer)}
      </RoundedBox>
      <RoundedBox args={[0.08, 0.62, 0.42]} radius={0.02} smoothness={3} position={[0.24, 0.38, 0.02]}>
        {clay(colors.printer)}
      </RoundedBox>
      <mesh position={[0, 0.4, -0.155]}>
        <planeGeometry args={[0.34, 0.28]} />
        <meshStandardMaterial
          color={colors.screenIdle}
          emissive={colors.uv}
          emissiveIntensity={glow}
          roughness={0.35}
          metalness={0.1}
        />
      </mesh>
      <mesh ref={plate} position={[0, 0.16, 0.02]}>
        <boxGeometry args={[0.34, 0.02, 0.3]} />
        {clay(colors.metal, { emissive: colors.uv, emissiveIntensity: printing ? 0.35 : 0 })}
      </mesh>
      {printing ? (
        <pointLight
          position={[0, 0.32, 0]}
          color={colors.uv}
          intensity={dark ? 2.6 : 0.7}
          distance={3.4}
          decay={2}
        />
      ) : null}
    </group>
  );
}

function StationLabel({ text, dark }: { text: string; dark: boolean }) {
  return (
    <Html
      position={[0, 0.92, 0.42]}
      center
      distanceFactor={9}
      zIndexRange={[10, 0]}
      wrapperClass="workshop-html-label"
      style={{ pointerEvents: "none" }}
    >
      <div className={dark ? "workshop-pin workshop-pin-dark" : "workshop-pin"}>{text}</div>
    </Html>
  );
}

function IntakeDesk({ colors }: { colors: Palette }) {
  return (
    <group>
      <RoundedBox args={[1.35, 0.08, 0.72]} radius={0.04} smoothness={3} position={[0, 0.42, 0]}>
        {clay(colors.wood)}
      </RoundedBox>
      <RoundedBox args={[0.08, 0.4, 0.08]} radius={0.02} smoothness={2} position={[-0.55, 0.2, 0.26]}>
        {clay(colors.woodDark)}
      </RoundedBox>
      <RoundedBox args={[0.08, 0.4, 0.08]} radius={0.02} smoothness={2} position={[0.55, 0.2, 0.26]}>
        {clay(colors.woodDark)}
      </RoundedBox>
      <RoundedBox args={[0.08, 0.4, 0.08]} radius={0.02} smoothness={2} position={[-0.55, 0.2, -0.26]}>
        {clay(colors.woodDark)}
      </RoundedBox>
      <RoundedBox args={[0.08, 0.4, 0.08]} radius={0.02} smoothness={2} position={[0.55, 0.2, -0.26]}>
        {clay(colors.woodDark)}
      </RoundedBox>
      <RoundedBox args={[0.28, 0.04, 0.22]} radius={0.02} smoothness={2} position={[-0.32, 0.48, 0.08]}>
        {clay(colors.paper)}
      </RoundedBox>
      <RoundedBox args={[0.22, 0.03, 0.16]} radius={0.02} smoothness={2} position={[-0.28, 0.52, 0.06]}>
        {clay(colors.paper)}
      </RoundedBox>
    </group>
  );
}

function WashStation({ colors, dark }: { colors: Palette; dark: boolean }) {
  return (
    <group>
      <RoundedBox args={[1.15, 0.28, 0.7]} radius={0.05} smoothness={3} position={[0, 0.22, 0]}>
        {clay(colors.metal)}
      </RoundedBox>
      <mesh position={[-0.22, 0.38, 0]}>
        <cylinderGeometry args={[0.2, 0.22, 0.14, 16]} />
        {clay(colors.wash, { emissive: "#4aa0c8", emissiveIntensity: dark ? 0.25 : 0.08 })}
      </mesh>
      <RoundedBox args={[0.38, 0.42, 0.38]} radius={0.04} smoothness={3} position={[0.28, 0.42, 0]}>
        {clay(colors.printer)}
      </RoundedBox>
      <mesh position={[0.28, 0.42, 0.2]}>
        <planeGeometry args={[0.22, 0.22]} />
        <meshStandardMaterial
          color={colors.screenIdle}
          emissive={colors.uv}
          emissiveIntensity={dark ? 1.1 : 0.35}
          roughness={0.4}
        />
      </mesh>
    </group>
  );
}

function QaTable({ colors, dark }: { colors: Palette; dark: boolean }) {
  return (
    <group>
      <RoundedBox args={[1.2, 0.08, 0.7]} radius={0.04} smoothness={3} position={[0, 0.4, 0]}>
        {clay(colors.wood)}
      </RoundedBox>
      <RoundedBox args={[0.07, 0.38, 0.07]} radius={0.02} smoothness={2} position={[-0.48, 0.19, 0.24]}>
        {clay(colors.woodDark)}
      </RoundedBox>
      <RoundedBox args={[0.07, 0.38, 0.07]} radius={0.02} smoothness={2} position={[0.48, 0.19, 0.24]}>
        {clay(colors.woodDark)}
      </RoundedBox>
      <RoundedBox args={[0.07, 0.38, 0.07]} radius={0.02} smoothness={2} position={[-0.48, 0.19, -0.24]}>
        {clay(colors.woodDark)}
      </RoundedBox>
      <RoundedBox args={[0.07, 0.38, 0.07]} radius={0.02} smoothness={2} position={[0.48, 0.19, -0.24]}>
        {clay(colors.woodDark)}
      </RoundedBox>
      <mesh position={[0.38, 0.72, -0.08]}>
        <cylinderGeometry args={[0.025, 0.025, 0.55, 8]} />
        {clay(colors.metal)}
      </mesh>
      <mesh position={[0.38, 1.02, 0.02]} rotation={[0.45, 0, 0]}>
        <coneGeometry args={[0.12, 0.16, 10]} />
        {clay(colors.woodDark, { emissive: colors.lamp, emissiveIntensity: dark ? 0.4 : 0.15 })}
      </mesh>
      <pointLight position={[0.3, 0.92, 0.1]} color={colors.lamp} intensity={dark ? 1.1 : 0.55} distance={2.8} />
    </group>
  );
}

function PackShelf({ colors }: { colors: Palette }) {
  return (
    <group>
      <RoundedBox args={[0.9, 0.9, 0.36]} radius={0.04} smoothness={3} position={[0, 0.48, 0]}>
        {clay(colors.wood)}
      </RoundedBox>
      <mesh position={[0, 0.28, 0.02]}>
        <boxGeometry args={[0.78, 0.03, 0.3]} />
        {clay(colors.woodDark)}
      </mesh>
      <mesh position={[0, 0.56, 0.02]}>
        <boxGeometry args={[0.78, 0.03, 0.3]} />
        {clay(colors.woodDark)}
      </mesh>
      <RoundedBox args={[0.22, 0.16, 0.16]} radius={0.03} smoothness={2} position={[-0.2, 0.38, 0.12]}>
        {clay("#c4b29a")}
      </RoundedBox>
      <RoundedBox args={[0.18, 0.14, 0.14]} radius={0.03} smoothness={2} position={[0.18, 0.66, 0.12]}>
        {clay("#d7c4a8")}
      </RoundedBox>
    </group>
  );
}

function Pegboard({
  tags,
  colors,
  dark,
}: {
  tags: WorkshopCanvasProps["tags"];
  colors: Palette;
  dark: boolean;
}) {
  return (
    <group position={[0, 1.55, -3.28]}>
      <RoundedBox args={[8.6, 1.45, 0.1]} radius={0.04} smoothness={3}>
        {clay(colors.wall)}
      </RoundedBox>
      {[-3, -1, 1, 3].map((x) =>
        [0.4, 0.05, -0.3].map((y) => (
          <mesh key={`${x}-${y}`} position={[x, y, 0.08]}>
            <cylinderGeometry args={[0.035, 0.035, 0.08, 8]} />
            {clay(colors.peg)}
          </mesh>
        )),
      )}
      {tags.map((tag, index) => {
        const x = -2.4 + index * 1.6;
        const lit = tag.tone === "green" ? "#7dce8a" : tag.tone === "amber" ? "#e0a45a" : "#8a8076";
        const intensity = tag.tone === "off" ? 0 : dark ? 1.4 : 0.55;
        return (
          <group key={tag.id} position={[x, 0.12, 0.12]}>
            <RoundedBox args={[0.72, 0.42, 0.06]} radius={0.04} smoothness={3}>
              {clay(colors.paper, { emissive: lit, emissiveIntensity: intensity * 0.35 })}
            </RoundedBox>
            <mesh position={[0, 0.24, 0.01]}>
              <sphereGeometry args={[0.04, 8, 8]} />
              {clay(colors.metal)}
            </mesh>
            <pointLight position={[0, 0, 0.2]} color={lit} intensity={intensity} distance={1.8} />
            <Html
              position={[0, -0.02, 0.05]}
              center
              distanceFactor={10}
              wrapperClass="workshop-html-label"
              style={{ pointerEvents: "none" }}
            >
              <div className={dark ? "workshop-tag-label workshop-tag-label-dark" : "workshop-tag-label"}>
                {tag.label}
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}

export function WorkshopScene({
  orders,
  tags,
  selectedDealId,
  printing,
  dark,
  reduceMotion,
  onHover,
  onSelect,
}: WorkshopCanvasProps) {
  const colors = useMemo(() => palette(dark), [dark]);
  const today = shipByCalendarDate();
  const grouped = useMemo(() => groupOrdersByStation(orders), [orders]);

  const markHover = (order: ProductionQueueItem, station: WorkshopStationId) => {
    onHover({
      dealId: order.dealId,
      name: orderTitle(order.dealName, order.contactName),
      shipBy: shopDateLabel({
        date: order.shipBy,
        today,
        source: order.shipBySource === "override" ? "override" : "derived",
        tentative: order.tentative,
      }),
      station,
    });
  };

  return (
    <>
      <color attach="background" args={[colors.void]} />
      <fog attach="fog" args={[colors.fog, 12, 28]} />
      <hemisphereLight
        args={[dark ? "#c8b8a4" : "#fff4e8", dark ? "#2a221c" : "#8d7f70", dark ? 0.55 : 0.62]}
      />
      {!dark ? (
        <directionalLight position={[6, 9, 4]} intensity={1.15} color="#fff1de" />
      ) : (
        <directionalLight position={[5, 8, 5]} intensity={0.55} color="#d9c4a0" />
      )}
      {!dark ? <directionalLight position={[-5, 4, -2]} intensity={0.28} color="#d7e2ee" /> : (
        <directionalLight position={[-3, 3, 4]} intensity={0.22} color="#8d78ff" />
      )}

      <RoundedBox args={[10.2, 0.28, 7.3]} radius={0.12} smoothness={4} position={[0, -0.14, 0]}>
        {clay(colors.slab)}
      </RoundedBox>
      <RoundedBox args={[10.35, 0.12, 7.45]} radius={0.1} smoothness={3} position={[0, -0.32, 0]}>
        {clay(colors.slabEdge)}
      </RoundedBox>

      <Pegboard tags={tags} colors={colors} dark={dark} />

      {WORKSHOP_STATIONS.map((station) => {
        const pose = STATION_POSE[station.id];
        const members = grouped[station.id];
        return (
          <group key={station.id} position={pose}>
            {station.id === "intake" ? <IntakeDesk colors={colors} /> : null}
            {station.id === "print" ? (
              <>
                <ResinPrinter position={[-0.42, 0, 0]} printing={printing} reduceMotion={reduceMotion} colors={colors} dark={dark} />
                <ResinPrinter position={[0.42, 0, 0]} printing={printing} reduceMotion={reduceMotion} colors={colors} dark={dark} />
              </>
            ) : null}
            {station.id === "wash" ? <WashStation colors={colors} dark={dark} /> : null}
            {station.id === "qa" ? <QaTable colors={colors} dark={dark} /> : null}
            {station.id === "pack" ? <PackShelf colors={colors} /> : null}
            <StationLabel text={station.label} dark={dark} />
            {members.map((order, index) => {
              const [x, , z] = tokenOffset(index, members.length);
              const front = station.id === "intake" ? 0.55 : 0.48;
              return (
                <ResinToken
                  key={order.dealId}
                  order={order}
                  position={[x, 0.48, z + front]}
                  selected={selectedDealId === order.dealId}
                  colors={colors}
                  today={today}
                  dark={dark}
                  reduceMotion={reduceMotion}
                  onHover={(hover) => (hover ? markHover(order, station.id) : onHover(null))}
                  onSelect={onSelect}
                />
              );
            })}
          </group>
        );
      })}
    </>
  );
}
