import { udcKeys } from "@jsudc/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

/** At most one refetch per this many ms, however fast events arrive. */
export const REFRESH_THROTTLE_MS = 250;

/**
 * A function that refetches every list of `collection`, at most once per `ms`: what a page
 * calls for each stream event. The rows always come from UDC; the stream only says "again".
 */
export function useThrottledRefresh(collection: string, ms = REFRESH_THROTTLE_MS): () => void {
  const queryClient = useQueryClient();
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      void queryClient.invalidateQueries({ queryKey: udcKeys.lists(collection) });
    }, ms);
  }, [queryClient, collection, ms]);
  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current);
    },
    [],
  );
  return refresh;
}

/**
 * Refetches every list of `collections` every `ms` while mounted: the live updates of a page
 * that has no stream to listen to (the service site — memento's `/ws` takes an API key, the
 * service site has only the session cookie).
 */
export function usePolling(collections: readonly string[], ms: number): void {
  const queryClient = useQueryClient();
  const key = collections.join("|");
  useEffect(() => {
    const timer = setInterval(() => {
      for (const collection of key.split("|")) {
        void queryClient.invalidateQueries({ queryKey: udcKeys.lists(collection) });
      }
    }, ms);
    return () => clearInterval(timer);
  }, [queryClient, key, ms]);
}
