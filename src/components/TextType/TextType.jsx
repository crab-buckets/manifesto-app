// A plain left-to-right typewriter reveal — used where DecryptedText's scramble effect is too much
// (a chat bubble, read over and over) but the same "something is arriving" feel is still wanted.
// Same onComplete-via-ref pattern as DecryptedText: an inline arrow function from the caller gets a
// fresh identity on every one of THEIR renders, and keeping it out of the interval effect's own
// dependency array stops that from tearing down and restarting the typing mid-message.
import { useEffect, useRef, useState } from 'react';

export default function TextType({ text, speed = 22, className = '', cursorClassName = 'type-cursor', showCursor = true, onComplete, ...props }) {
  const [count, setCount] = useState(0);
  const intervalRef = useRef(null);
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);

  useEffect(() => {
    setCount(0);
    clearInterval(intervalRef.current);
    if (!text) { onCompleteRef.current?.(); return; }
    let i = 0;
    intervalRef.current = setInterval(() => {
      i += 1;
      setCount(i);
      if (i >= text.length) {
        clearInterval(intervalRef.current);
        onCompleteRef.current?.();
      }
    }, speed);
    return () => clearInterval(intervalRef.current);
  }, [text, speed]);

  const done = count >= text.length;
  return (
    <span className={className} {...props}>
      {text.slice(0, count)}
      {showCursor && !done && <span className={cursorClassName} aria-hidden="true">▌</span>}
    </span>
  );
}
