import { BridgeServiceRecord } from '../types';

export interface HostSelectionOptions {
  staleAfterMs?: number;
  now?: () => number;
}

export interface TrackedHost {
  identity: string;
  service: BridgeServiceRecord;
  firstSeenAt: number;
  lastSeenAt: number;
  seenCount: number;
}

interface MutableTrackedHost extends TrackedHost {
  serviceIds: Set<string>;
}

const DEFAULT_STALE_AFTER_MS = 15000;

export class HostSelection {
  private readonly staleAfterMs: number;
  private readonly now: () => number;

  private readonly hostsByIdentity = new Map<string, MutableTrackedHost>();
  private readonly idToIdentity = new Map<string, string>();

  public constructor(options: HostSelectionOptions = {}) {
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.now = options.now ?? (() => Date.now());
  }

  public upsert(service: BridgeServiceRecord, seenAt = this.now()): TrackedHost {
    const identity = service.identity;
    const existing = this.hostsByIdentity.get(identity);

    if (existing) {
      existing.service = service;
      existing.lastSeenAt = seenAt;
      existing.seenCount += 1;
      existing.serviceIds.add(service.id);
      this.idToIdentity.set(service.id, identity);
      return this.copyHost(existing);
    }

    const tracked: MutableTrackedHost = {
      identity,
      service,
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      seenCount: 1,
      serviceIds: new Set([service.id]),
    };

    this.hostsByIdentity.set(identity, tracked);
    this.idToIdentity.set(service.id, identity);
    return this.copyHost(tracked);
  }

  public markDown(serviceId: string): boolean {
    const identity = this.idToIdentity.get(serviceId);
    if (!identity) {
      return false;
    }

    this.idToIdentity.delete(serviceId);

    const tracked = this.hostsByIdentity.get(identity);
    if (!tracked) {
      return false;
    }

    tracked.serviceIds.delete(serviceId);
    if (tracked.serviceIds.size > 0) {
      return false;
    }

    this.hostsByIdentity.delete(identity);
    return true;
  }

  public pruneStale(now = this.now()): TrackedHost[] {
    const removed: TrackedHost[] = [];

    for (const [identity, tracked] of this.hostsByIdentity.entries()) {
      const ageMs = now - tracked.lastSeenAt;
      if (ageMs <= this.staleAfterMs) {
        continue;
      }

      for (const serviceId of tracked.serviceIds) {
        this.idToIdentity.delete(serviceId);
      }

      this.hostsByIdentity.delete(identity);
      removed.push(this.copyHost(tracked));
    }

    return removed;
  }

  public selectPreferred(currentConnectedIdentity?: string): BridgeServiceRecord | null {
    this.pruneStale();

    const candidates = [...this.hostsByIdentity.values()];
    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((left, right) => {
      if (left.lastSeenAt !== right.lastSeenAt) {
        return right.lastSeenAt - left.lastSeenAt;
      }

      if (left.seenCount !== right.seenCount) {
        return right.seenCount - left.seenCount;
      }

      const leftConnected = left.identity === currentConnectedIdentity ? 1 : 0;
      const rightConnected = right.identity === currentConnectedIdentity ? 1 : 0;
      if (leftConnected !== rightConnected) {
        return rightConnected - leftConnected;
      }

      return left.identity.localeCompare(right.identity);
    });

    return { ...candidates[0].service };
  }

  public listHosts(): TrackedHost[] {
    this.pruneStale();
    return [...this.hostsByIdentity.values()].map((host) => this.copyHost(host));
  }

  private copyHost(host: MutableTrackedHost): TrackedHost {
    return {
      identity: host.identity,
      service: { ...host.service },
      firstSeenAt: host.firstSeenAt,
      lastSeenAt: host.lastSeenAt,
      seenCount: host.seenCount,
    };
  }
}
