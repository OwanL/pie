export interface RefreshableModelRegistry {
  refresh(): void;
}

type CatalogRefresh<TRegistry extends RefreshableModelRegistry> = (registry: TRegistry) => Promise<void>;

/**
 * Process-local single-flight coordination for account catalog refreshes.
 *
 * Pie may create several session runtimes concurrently at startup, each with
 * its own ModelRegistry. Only one runtime should fetch and write the shared
 * catalog, but every participating registry must reload the resulting file.
 * Failed attempts are deliberately not cached, so the next session retries.
 */
export class CopilotCatalogRefreshCoordinator<TRegistry extends RefreshableModelRegistry = RefreshableModelRegistry> {
  private inFlight: Promise<void> | undefined;

  constructor(private readonly runRefresh: CatalogRefresh<TRegistry>) {}

  async refresh(registry: TRegistry): Promise<void> {
    const operation = this.inFlight ?? this.begin(registry);
    await operation;
    registry.refresh();
  }

  private begin(registry: TRegistry): Promise<void> {
    const operation = this.runRefresh(registry);
    this.inFlight = operation;
    const clear = () => {
      if (this.inFlight === operation) this.inFlight = undefined;
    };
    operation.then(clear, clear);
    return operation;
  }
}
