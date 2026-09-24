import { useEffect, useRef } from 'react';

/* Ambient background: three large, softly blurred colour blobs drifting slowly (pure CSS,
   theme-reactive since they read the panel's own custom properties), plus a very faint animated
   grain layer for texture. This replaces the old WebGL dither, which was heavy and — on the
   deployed site — sat frozen instead of moving. The CSS animation can't silently fail to run the
   way a WebGL frame loop could, and it costs far less. */
export default function Ambient({ animate = true }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const size = 64;
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const draw = () => {
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = (Math.random() * 255) | 0;
        d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    };
    draw();
    if (animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const id = setInterval(draw, 130);
      return () => clearInterval(id);
    }
    return undefined;
  }, [animate]);
  return (
    <div className="bg-dither" aria-hidden="true" data-animate={animate}>
      <div className="bg-wave"><span /><span /><span /></div>
      <canvas ref={ref} className="grain-canvas" />
    </div>
  );
}
