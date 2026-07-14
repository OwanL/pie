/**
 * Bundle-safe bridge for live host ProviderGate capacity.
 *
 * The VS Code backend and pi extensions are bundled/loaded independently, so
 * module-local singletons are not shared. A Symbol.for key on globalThis gives
 * both copies access to the same live reader without using process.env for
 * dynamic occupancy.
 */

export interface ProviderCapacityState {
  /** Whether a new, unrelated session can claim a provider slot immediately. */
  immediatelyClaimable: boolean;
}

export type ProviderCapacitySnapshot = Readonly<Record<string, ProviderCapacityState>>;
export type ProviderCapacityReader = () => ProviderCapacitySnapshot;

const BRIDGE_KEY = Symbol.for("pie.provider-capacity-bridge.v1");

interface BridgeRegistration {
  version: 1;
  read: ProviderCapacityReader;
}

function bridgeHost(): Record<PropertyKey, unknown> {
  return globalThis as unknown as Record<PropertyKey, unknown>;
}

/** Publish a live capacity reader. The returned disposer only removes its own registration. */
export function installProviderCapacityBridge(read: ProviderCapacityReader): () => void {
  const registration: BridgeRegistration = { version: 1, read };
  bridgeHost()[BRIDGE_KEY] = registration;
  return () => {
    if (bridgeHost()[BRIDGE_KEY] === registration) delete bridgeHost()[BRIDGE_KEY];
  };
}

/** Read the latest capacity snapshot. Missing/invalid/throwing bridges fail open. */
export function readProviderCapacitySnapshot(): ProviderCapacitySnapshot | undefined {
  const registration = bridgeHost()[BRIDGE_KEY] as Partial<BridgeRegistration> | undefined;
  if (!registration || registration.version !== 1 || typeof registration.read !== "function") {
    return undefined;
  }
  try {
    const snapshot = registration.read();
    return snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? snapshot
      : undefined;
  } catch {
    return undefined;
  }
}
