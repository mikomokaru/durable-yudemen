// Types for the driver-side ledger. The implementation stays JavaScript because
// it runs as a plain Node module in the harness, but its contract is checked.
export type TrialLedgerKind = "dispatch" | "operation" | "connection";

export interface TrialLedgerLimits {
  readonly dispatch: number;
  readonly operation: number;
  readonly connection: number;
  readonly concurrent: number;
  /** Sockets connecting or connected at once. Independent of `concurrent`. */
  readonly openConnections: number;
}

export interface TrialLedgerTotals {
  readonly dispatch: number;
  readonly operation: number;
  readonly connection: number;
  readonly inFlight: number;
  readonly openConnections: number;
  readonly unconfirmedConnections: number;
  readonly unsettledFromEarlierRuns: Record<TrialLedgerKind, number>;
  readonly observedDispatches: number;
  /** Sends with no reservation to test the per-operation hypothesis against. */
  readonly unattributedDispatches: number;
  /** Whether replay could reach the same stop from the journal alone. */
  /** Sessions opened against this journal, each with its own time window. */
  readonly windows: number;
  readonly stopIsRederivable: boolean | null;
  readonly stopped: { readonly reason: string; readonly detail: unknown } | null;
}

export class TrialBudgetExceeded extends Error {
  readonly reason: string;
  readonly detail: unknown;
}

export class TrialLedger {
  static open(
    path: string,
    trial: Readonly<Record<string, unknown>>,
    limits: TrialLedgerLimits,
  ): Promise<TrialLedger>;
  readonly totals: TrialLedgerTotals;
  /** `allowance` defaults to 1 for `operation` and 0 otherwise. */
  reserve(kind: TrialLedgerKind, allowance?: number): Promise<string>;
  settle(id: string, outcome: string): Promise<void>;
  /**
   * `"closed"` or `"failed"` return the simultaneity slot; any other outcome
   * keeps it and records the connection as unconfirmed. The cumulative attempt
   * is never returned.
   */
  releaseConnection(id: string, outcome: string): Promise<void>;
  /** Pass `reservation` to test the declared allowance, not only the total. */
  recordObservedDispatch(
    requestId: string,
    reservation?: string,
  ): Promise<{ requestId: string; at: number }>;
  close(): Promise<void>;
}
