export interface PendingEntry {
  jobId: number;
  text: string;
  assetIds: string[];
}

/**
 * Inputs waiting to reach the agent, per sender. The scheduler moves a batch to in-flight
 * when a turn starts; the agent can take newer arrivals mid-turn (step-boundary interrupt),
 * and the scheduler marks every in-flight entry done when the turn ends.
 */
export class PendingInputs {
  private readonly pending = new Map<string, PendingEntry[]>();
  private readonly inFlight = new Map<string, PendingEntry[]>();

  add(sender: string, entry: PendingEntry): void {
    const entries = this.pending.get(sender) ?? [];
    entries.push(entry);
    this.pending.set(sender, entries);
  }

  hasPending(sender: string): boolean {
    return (this.pending.get(sender)?.length ?? 0) > 0;
  }

  hasAny(): boolean {
    return [...this.pending.values(), ...this.inFlight.values()].some((entries) => entries.length > 0);
  }

  take(sender: string): PendingEntry[] {
    const entries = this.pending.get(sender) ?? [];
    this.pending.delete(sender);
    if (entries.length > 0) {
      this.inFlight.set(sender, [...(this.inFlight.get(sender) ?? []), ...entries]);
    }
    return entries;
  }

  peekInFlight(sender: string): PendingEntry[] {
    return this.inFlight.get(sender) ?? [];
  }

  finish(sender: string): PendingEntry[] {
    const entries = this.inFlight.get(sender) ?? [];
    this.inFlight.delete(sender);
    return entries;
  }
}
