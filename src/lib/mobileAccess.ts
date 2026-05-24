import { useEffect, useState } from "react";

export function isMobileAccessViewport() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(max-width: 767px)").matches;
}

export function useIsMobileAccess() {
  const [isMobileAccess, setIsMobileAccess] = useState(() => isMobileAccessViewport());

  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobileAccess(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return isMobileAccess;
}
