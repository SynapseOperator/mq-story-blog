"use client";

import { useEffect, useRef } from "react";

/** One scene owns its pointer subscription; motion never changes React state. */
export function useSceneMotion(enabled: boolean) {
  const sceneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = sceneRef.current;
    if (!element) return;
    const scene = element;

    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let canMove = false;
    let frame: number | null = null;
    let lastTime: number | null = null;
    let x = 0;
    let y = 0;
    let targetX = 0;
    let targetY = 0;

    function paint() {
      scene.style.setProperty("--scene-x", `${x.toFixed(3)}px`);
      scene.style.setProperty("--scene-y", `${y.toFixed(3)}px`);
    }

    function reset() {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = null;
      lastTime = null;
      x = y = targetX = targetY = 0;
      paint();
    }

    function updateMode() {
      const paused = !enabled || reducedMotion.matches || document.visibilityState !== "visible";
      // Coarse pointers disable parallax, but may still enjoy ambient animation.
      scene.dataset.paused = String(paused);
      canMove = !paused && finePointer.matches;
      reset();
    }

    function advance(time: number) {
      frame = null;
      if (!canMove) return;

      const elapsed = lastTime === null ? 16.67 : Math.min(time - lastTime, 64);
      lastTime = time;
      const ease = 1 - Math.exp(-elapsed / 90);
      x += (targetX - x) * ease;
      y += (targetY - y) * ease;

      if (Math.abs(targetX - x) < 0.01 && Math.abs(targetY - y) < 0.01) {
        x = targetX;
        y = targetY;
        lastTime = null;
        paint();
        return;
      }

      paint();
      frame = window.requestAnimationFrame(advance);
    }

    function onPointerMove(event: PointerEvent) {
      if (!canMove || event.pointerType === "touch") return;
      const normalizedX = event.clientX / Math.max(window.innerWidth, 1) * 2 - 1;
      const normalizedY = event.clientY / Math.max(window.innerHeight, 1) * 2 - 1;
      targetX = Math.max(-1, Math.min(1, normalizedX)) * 6;
      targetY = Math.max(-1, Math.min(1, normalizedY)) * 4;
      if (frame === null && (targetX !== x || targetY !== y)) {
        frame = window.requestAnimationFrame(advance);
      }
    }

    function onMouseOut(event: MouseEvent) {
      if (event.relatedTarget === null) reset();
    }

    updateMode();
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("mouseout", onMouseOut);
    window.addEventListener("blur", reset);
    window.addEventListener("pointercancel", reset);
    window.addEventListener("resize", reset);
    document.addEventListener("visibilitychange", updateMode);
    finePointer.addEventListener("change", updateMode);
    reducedMotion.addEventListener("change", updateMode);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("mouseout", onMouseOut);
      window.removeEventListener("blur", reset);
      window.removeEventListener("pointercancel", reset);
      window.removeEventListener("resize", reset);
      document.removeEventListener("visibilitychange", updateMode);
      finePointer.removeEventListener("change", updateMode);
      reducedMotion.removeEventListener("change", updateMode);
      reset();
      scene.style.removeProperty("--scene-x");
      scene.style.removeProperty("--scene-y");
      delete scene.dataset.paused;
    };
  }, [enabled]);

  return sceneRef;
}
