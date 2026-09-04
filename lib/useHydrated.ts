"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/** Chỉ trả true sau khi React đã hydrate xong, không cần setState đồng bộ trong effect. */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}
