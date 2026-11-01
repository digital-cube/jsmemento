import { Spinner } from "@jsudc/react/ui";
import { useEffect, useRef } from "react";

/** The next page: as soon as the end of the list scrolls into view, or on a click. */
export function MoreRows({
  loading,
  onMore,
  children,
}: {
  loading: boolean;
  onMore: () => void;
  children: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const more = useRef(onMore);
  more.current = onMore;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) more.current();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <button ref={ref} type="button" className="feed__more" disabled={loading} onClick={onMore}>
      {loading ? <Spinner /> : children}
    </button>
  );
}
