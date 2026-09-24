import { useEffect, useRef } from 'react';

/* A small, cheap stand-in for the old WebGL dither: a low-res canvas of random noise, scaled up
   blocky (image-rendering: pixelated) and tinted per theme. No Three.js, no shader compile, and
   unlike the old one, it reliably keeps moving — the WebGL version was heavy and, on the deployed
   site, sat frozen on its first frame. This redraws on a plain interval instead. */
export default function Grain({ tint = '#b08d3c', animate = true, size = 72, fps = 10 }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
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
      const id = setInterval(draw, 1000 / fps);
      return () => clearInterval(id);
    }
    return undefined;
  }, [animate, size, fps]);
  return (
    <div className="grain-wrap" aria-hidden="true">
      <canvas ref={ref} className="grain-canvas" />
      <div className="grain-tint" style={{ background: tint }} />
    </div>
  );
}
