/** Independent static layers; motion and story hotspots belong to Issue #3. */
export function Landscape() {
  return (
    <div className="landscape" aria-hidden="true">
      <div className="scene-artboard">
        <div className="scene-sky scene-layer" data-scene-layer="sky">
          <img src="/scene/night-sky.webp" alt="" width="1536" height="1024" fetchPriority="high" />
        </div>
        <div className="scene-terrain scene-layer" data-scene-layer="terrain">
          <img src="/scene/grassy-hillside.webp" alt="" width="1536" height="1024" />
        </div>
        <div className="scene-firelight" data-scene-layer="firelight">
          <img src="/scene/firelight.webp" alt="" width="1536" height="1024" />
        </div>
        <div className="scene-couple" data-scene-layer="couple">
          <img src="/scene/couple.webp" alt="" width="1536" height="1024" />
        </div>
        {/* Reuse aligned foreground grass only at the seating edge for contact. */}
        <div className="scene-contact-grass scene-layer" data-scene-layer="contact-grass">
          <img src="/scene/grassy-hillside.webp" alt="" width="1536" height="1024" />
        </div>
        <div className="scene-campfire-flame" data-scene-layer="campfire-flame">
          <img src="/scene/campfire-flame.webp" alt="" width="1536" height="1024" />
        </div>
        {/* Logs occlude the flame base; their future transforms remain independent. */}
        <div className="scene-campfire-wood" data-scene-layer="campfire-wood">
          <img src="/scene/campfire-wood.webp" alt="" width="1536" height="1024" />
        </div>
      </div>
    </div>
  );
}
