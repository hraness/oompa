import type { PulseFetch } from "./http.ts";
import type { PrCategory, PrSignal } from "./model.ts";

export interface PulseSourceContext {
  readonly fetchText: PulseFetch;
  readonly fetchJson: (url: string, options?: {
    readonly label?: string;
    readonly maxBytes?: number;
    readonly timeoutMs?: number;
  }) => Promise<unknown>;
  readonly now: Date;
}

/**
 * One adapter per upstream source. Collectors must be fully bounded: every
 * fetch carries a timeout and byte cap, and a throw only marks the source
 * unhealthy in the snapshot; it never aborts the pipeline.
 */
export interface PulseSource {
  readonly id: string;
  readonly name: string;
  readonly category: PrCategory;
  readonly homepage: string;
  readonly collect: (context: PulseSourceContext) => Promise<readonly PrSignal[]>;
}
