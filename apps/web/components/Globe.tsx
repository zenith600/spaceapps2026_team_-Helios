"use client";
import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import type { Target } from "@/lib/types";

function radec(ra: number, dec: number, r = 1.005): [number, number, number] {
  const a = (ra * Math.PI) / 180, d = (dec * Math.PI) / 180;
  // Match the equirectangular texture mapping of THREE.SphereGeometry (u from +x around -z).
  return [-r * Math.cos(d) * Math.cos(a), r * Math.sin(d), r * Math.cos(d) * Math.sin(a)];
}

/**
 * Load the texture without suspending.
 *
 * drei's `useTexture` suspends and *throws* when the image 404s, which escapes the Canvas
 * and takes the whole page down with a runtime error. That is a bad trade for a decorative
 * map: if the texture is missing the globe should still turn, just plain. Loading it by
 * hand keeps the failure local and reportable.
 */
function useOptionalTexture(url: string) {
  const [state, setState] = useState<{ tex: THREE.Texture | null; failed: boolean }>({ tex: null, failed: false });
  useEffect(() => {
    if (!url) { setState({ tex: null, failed: true }); return; }
    let cancelled = false;
    const loader = new THREE.TextureLoader();
    loader.load(
      url,
      (tex) => {
        if (cancelled) { tex.dispose(); return; }
        tex.colorSpace = THREE.SRGBColorSpace;
        setState({ tex, failed: false });
      },
      undefined,
      () => { if (!cancelled) setState({ tex: null, failed: true }); },
    );
    return () => { cancelled = true; };
  }, [url]);
  return state;
}

function Sky({ tex, targets }: { tex: THREE.Texture | null; targets: Target[] }) {
  const g = useRef<THREE.Group>(null);
  useFrame((_, dt) => { if (g.current) g.current.rotation.y += dt * 0.05; });
  return (
    <group ref={g}>
      <mesh>
        <sphereGeometry args={[1, 64, 64]} />
        {tex
          ? <meshBasicMaterial map={tex} side={THREE.FrontSide} />
          : <meshBasicMaterial color="#121726" side={THREE.FrontSide} wireframe={false} />}
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
  const { tex, failed } = useOptionalTexture(texture);
  return (
    <div className="relative h-[320px] w-full sm:h-[420px]">
      <Canvas camera={{ position: [0, 0.6, 2.6], fov: 45 }} dpr={[1, 2]}>
        <Sky tex={tex} targets={targets} />
        <OrbitControls enablePan={false} minDistance={1.6} maxDistance={4} />
      </Canvas>
      {failed ? (
        <p className="pointer-events-none absolute bottom-2 left-2 rounded bg-bg/80 px-2 py-1 text-[10px] text-muted">
          exclusion-map texture unavailable — patches still shown
        </p>
      ) : null}
    </div>
  );
}
