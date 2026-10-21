/** Independent static layers; motion and story hotspots belong to Issue #3. */
export function Landscape() {
  return (
    <div className="landscape" aria-hidden="true">
      <div className="scene-sky scene-layer" data-scene-layer="sky">
        <img src="/scene/night-sky.webp" alt="" width="1536" height="1024" fetchPriority="high" />
      </div>
      <div className="scene-atmosphere scene-layer" />
      <div className="scene-terrain scene-layer" data-scene-layer="terrain">
        <img src="/scene/grassy-hillside.webp" alt="" width="1536" height="1024" />
      </div>
      <div className="scene-firelight" data-scene-layer="firelight" />
      <div className="scene-couple" data-scene-layer="couple">
        <img src="/scene/couple.webp" alt="" width="900" height="900" />
      </div>
      <div className="scene-campfire" data-scene-layer="campfire">
        <img src="/scene/campfire.webp" alt="" width="600" height="600" />
      </div>
      <div className="scene-vignette scene-layer" />
    </div>
  );
}
