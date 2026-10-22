"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { campfireStory, starStories, type DemoStory } from "./demo-stories";
import { useSceneMotion } from "./use-scene-motion";

// Small glints only: decorative, deterministic and never part of the focus order.
const dust = [
  [12, 19, 7, -2], [23, 9, 9, -6], [39, 15, 8, -3], [62, 10, 11, -8],
  [86, 22, 8, -5], [19, 35, 10, -4], [42, 41, 7, -6], [59, 36, 12, -9],
  [75, 43, 9, -3], [91, 38, 11, -7], [31, 48, 10, -1], [69, 18, 8, -7],
];

function BackdropImage({ asset, priority }: { asset: "night-sky" | "grassy-hillside"; priority?: "high" }) {
  return (
    <picture>
      {/* Same source pixels and composition; preserve fine texture without lossy encoding on dense portrait screens. */}
      <source media="(max-aspect-ratio: 1/1) and (min-resolution: 1.5dppx)" srcSet={`/scene/${asset}-lossless.webp`} />
      <img src={`/scene/${asset}.webp`} alt="" width="1536" height="1024" fetchPriority={priority} />
    </picture>
  );
}

export function Landscape({ interactive = false, reading = false, onRead }: {
  interactive?: boolean;
  reading?: boolean;
  onRead?: (story: DemoStory, trigger: HTMLButtonElement) => void;
}) {
  const sceneRef = useSceneMotion(interactive && !reading);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const active = reading ? null : focused ?? hovered;
  const fireActive = active === campfireStory.id;

  useEffect(() => {
    function clearEmphasis() { setHovered(null); setFocused(null); }
    function visibilityChanged() { if (document.hidden) clearEmphasis(); }
    window.addEventListener("blur", clearEmphasis);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      window.removeEventListener("blur", clearEmphasis);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, []);

  function entry(story: DemoStory) {
    const showTitle = active === story.id && dismissed !== story.id;
    return (
      <button type="button" className={`story-entry story-entry--${story.entry}`}
        data-story-id={story.id} data-highlighted={active === story.id}
        aria-label={`合成演示故事：${story.title}`}
        aria-haspopup="dialog"
        disabled={reading}
        aria-describedby={showTitle ? `${story.id}-title` : undefined}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse" && matchMedia("(hover: hover)").matches) {
            setFocused(null);
            setHovered(story.id);
            setDismissed(null);
          }
        }}
        onPointerLeave={() => setHovered(null)}
        onPointerCancel={() => setHovered(null)}
        onFocus={(event) => {
          // Pointer focus must not leave the fire burning high after mouseout.
          if (event.currentTarget.matches(":focus-visible")) {
            setFocused(story.id);
            setDismissed(null);
          }
        }}
        onBlur={() => setFocused(null)}
        onClick={(event) => {
          if (reading) return;
          setHovered(null);
          setFocused(null);
          onRead?.(story, event.currentTarget);
        }}>
        {story.entry === "star" ? <span className="story-star" aria-hidden="true" /> : null}
        <span id={`${story.id}-title`} className="story-tooltip" role="tooltip" hidden={!showTitle}>
          <small>合成演示</small>{story.title}
        </span>
      </button>
    );
  }

  return (
    <div ref={sceneRef} className={`landscape${interactive ? " landscape--interactive" : ""}`}
      data-fire-active={fireActive} onPointerLeave={() => setHovered(null)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setDismissed(active);
          setHovered(null);
          setFocused(null);
        }
      }}>
      <div className="scene-artboard">
        {/* The stationary copy fills only the edge pixels exposed by parallax. */}
        <div className="scene-sky scene-layer" aria-hidden="true">
          <BackdropImage asset="night-sky" priority="high" />
        </div>
        <div className="scene-plane scene-plane--far">
          <div className="scene-sky scene-layer" data-scene-layer="sky" aria-hidden="true">
            <BackdropImage asset="night-sky" />
          </div>
        </div>
        <div className="scene-plane scene-plane--near">
          <div className="scene-terrain scene-layer" data-scene-layer="terrain" aria-hidden="true">
            <BackdropImage asset="grassy-hillside" />
          </div>
          <div className="scene-firelight" data-scene-layer="firelight" aria-hidden="true">
            <div className="firelight-breathe"><img src="/scene/firelight.webp" alt="" width="1536" height="1024" /></div>
          </div>
          <div className="scene-couple" data-scene-layer="couple" aria-hidden="true">
            <img src="/scene/couple.webp" alt="" width="1536" height="1024" />
          </div>
          <div className="scene-contact-grass scene-layer" data-scene-layer="contact-grass" aria-hidden="true">
            <BackdropImage asset="grassy-hillside" />
          </div>
          {interactive ? <div className="scene-grass-breeze scene-layer" aria-hidden="true">
            <BackdropImage asset="grassy-hillside" />
          </div> : null}
          <div className="scene-campfire-flame" data-scene-layer="campfire-flame" aria-hidden="true">
            <div className="flame-intensity"><div className="flame-burn">
              <img src="/scene/campfire-flame.webp" alt="" width="1536" height="1024" />
            </div></div>
          </div>
          <div className="scene-campfire-wood" data-scene-layer="campfire-wood">
            <img src="/scene/campfire-wood.webp" alt="" width="1536" height="1024" />
            {interactive ? entry(campfireStory) : null}
          </div>
        </div>
      </div>
      {interactive ? <>
        {/* Visible stars and hit areas always share this exact camera transform. */}
        <div className="scene-star-plane scene-plane--far" role="group" aria-label="演示故事星星">
          <div className="scene-dust" aria-hidden="true">
            {dust.map(([x, y, duration, delay], index) => <i key={index} style={{
              left: `${x}%`, top: `${y}%`, "--twinkle-duration": `${duration}s`, "--twinkle-delay": `${delay}s`,
            } as CSSProperties} />)}
          </div>
          {starStories.map((story, index) => <div key={story.id} className={`story-position story-position--${index + 1}`}>
            {entry(story)}
          </div>)}
        </div>
      </> : null}
    </div>
  );
}
