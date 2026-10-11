"use client";

import { useSyncExternalStore } from "react";

/** Phones and tablets: a narrow screen or a touch screen. */
const QUERY = "(max-width: 767px), (pointer: coarse)";

function subscribe(onChange: () => void) {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/**
 * True on phones and tablets, where heavy views (3D graphs, a graph docked over the reader) should start off
 * lighter. Server renders assume a compact screen, so a phone never starts loading the heavy view first.
 */
export function useCompactScreen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => true,
  );
}
