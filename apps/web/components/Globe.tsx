"use client";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, useTexture } from "@react-three/drei";
import { Suspense, useRef } from "react";
import * as THREE from "three";
import type { Target } from "@/lib/types";

function radec(ra: number, dec: number, r = 1.005): [number, number, number] {
  const a = (ra * Math.PI) / 180, d = (dec * Math.PI) / 180;
  // Match the equirectangular texture mapping of THREE.SphereGeometry (u from +x around -z).
  return [-r * Math.cos(d) * Math.cos(a), r * Math.sin(d), r * Math.cos(d) * Math.sin(a)];
}

function Sky({ texture, targets }: { texture: string; targets: Target[] }) {
  const tex = useTexture(texture);
  tex.colorSpace = THREE.SRGBColorSpace;
  const g = useRef<THREE.Group>(null);
  useFrame((_, dt) => { if (g.current) g.current.rotation.y += dt * 0.05; });
  return (
    <group ref={g}>
      <mesh>
        <sphereGeometry args={[1, 64, 64]} />
        <meshBasicMaterial map={tex} side={THREE.FrontSide} />
      </mesh>
      {targets.map((t) => (
        <mesh key={t.patch_id} position={radec(t.ra_deg, t.dec_deg)}>
          <sphereGeometry args={[0.018, 12, 12]} />
          <meshBasicMaterial color={t.status === "searched" ? "#22c55e" : "#f59e0b"} />
        </mesh>
      ))}
    </group>
  );
}

export function Globe({ texture, targets }: { texture: string; targets: Target[] }) {
  return (
    <div className="h-[320px] w-full sm:h-[420px]">
      <Canvas camera={{ position: [0, 0.6, 2.6], fov: 45 }} dpr={[1, 2]}>
        <Suspense fallback={null}>
          <Sky texture={texture} targets={targets} />
        </Suspense>
        <OrbitControls enablePan={false} minDistance={1.6} maxDistance={4} />
      </Canvas>
    </div>
  );
}
