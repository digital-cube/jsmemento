import type { LiveStatus } from "./hooks.js";

const LABELS: Record<LiveStatus, string> = {
  live: "Live",
  connecting: "Connecting",
  offline: "Offline, reconnecting",
  closed: "Disconnected",
  off: "Not live",
};

export interface StatusIndicatorProps {
  status: LiveStatus;
  /** Override the text next to the dot. */
  label?: string;
}

/** Green dot while the stream is live, red while it is offline. */
export function StatusIndicator({ status, label }: StatusIndicatorProps) {
  return (
    <span className="memento-status" data-status={status} role="status" aria-live="polite">
      <span className="memento-status__dot" aria-hidden="true" />
      {label ?? LABELS[status]}
    </span>
  );
}
