import { useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

// Same scroll-scrubbed reveal as ScrollReveal (fade, un-blur, un-tilt), but for a whole block instead of words.
export default function RevealBox({ children, baseOpacity = 0.12, baseRotation = 3, blurStrength = 5, className = '' }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const tween = gsap.fromTo(
      el,
      { opacity: baseOpacity, rotate: baseRotation, filter: `blur(${blurStrength}px)`, transformOrigin: '0% 50%' },
      { opacity: 1, rotate: 0, filter: 'blur(0px)', ease: 'none', scrollTrigger: { trigger: el, start: 'top bottom-=4%', end: 'top 68%', scrub: true } }
    );
    return () => { tween.scrollTrigger?.kill(); tween.kill(); };
  }, [baseOpacity, baseRotation, blurStrength]);
  return <div ref={ref} className={className}>{children}</div>;
}
