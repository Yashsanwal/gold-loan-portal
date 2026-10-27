import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export type Route = "apply" | "assist" | "admin";
const ROUTES: Route[] = ["apply", "assist", "admin"];

function readRoute(): Route {
  const hash = window.location.hash.replace(/^#\/?/, "").split(/[?/]/)[0] as Route;
  return ROUTES.includes(hash) ? hash : "apply";
}

function subscribe(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

/** Hash routing keeps the SPA deployable on any static host without rewrite rules. */
export function useRoute(): [Route, (route: Route) => void] {
  const route = useSyncExternalStore(subscribe, readRoute, () => "apply" as Route);
  const navigate = useCallback((next: Route) => {
    window.location.hash = `/${next}`;
  }, []);
  return [route, navigate];
}

/** Session storage that never throws (private mode, blocked storage). */
export const safeSession = {
  get(key: string): string | null {
    try {
      return window.sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null): void {
    try {
      if (value === null) window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, value);
    } catch {
      /* storage unavailable: state just won't survive a reload */
    }
  },
};

export function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
