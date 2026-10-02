export type ExecutionMilestone = "AUTHORIZED" | "PROCESSING" | "OUTPUT_VERIFIED" | "PROVENANCE_V2"
  | "SOLANA_VERIFIED" | "ROYALTY_ALLOCATED" | "BLOCKED";

export interface ExecutionObservation {
  readonly milestone: ExecutionMilestone;
  readonly observedAt: string;
}
export type ExecutionObserver = (event: Readonly<ExecutionObservation>) => void | Promise<void>;

/** Observations contain no protocol objects; notification errors never propagate. */
export function notifyExecutionObserver(observer: ExecutionObserver | undefined, milestone: ExecutionMilestone): void {
  if (!observer) return;
  try {
    const response = observer(Object.freeze({ milestone, observedAt: new Date().toISOString() }));
    if (response) void Promise.resolve(response).catch(() => {});
  } catch { /* Monitoring must not affect protocol execution. */ }
}
