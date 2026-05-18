export type RuntimeIdentityID = string & {
  readonly __runtimeIdentityID: unique symbol;
};

export type RuntimeIdentityRecord = {
  id: RuntimeIdentityID;
  startedAt: number;
};

export type RuntimeScoped<T extends object> = T & {
  readonly runtimeIdentityID: RuntimeIdentityID;
};

const CURRENT_RUNTIME_IDENTITY_STORAGE_KEY = 'currentRuntimeIdentity';

function runtimeIdentityID(value: string): RuntimeIdentityID {
  return value as RuntimeIdentityID;
}

export class RuntimeIdentity {
  readonly id: RuntimeIdentityID;
  readonly startedAt: number;

  constructor(record: RuntimeIdentityRecord) {
    this.id = record.id;
    this.startedAt = record.startedAt;
  }

  owns(record: { readonly runtimeIdentityID: RuntimeIdentityID }): boolean {
    return record.runtimeIdentityID === this.id;
  }

  scope<T extends object>(value: T): RuntimeScoped<T> {
    return {
      ...value,
      runtimeIdentityID: this.id
    };
  }
}

export class CurrentRuntimeIdentity {
  constructor(
    private readonly storage: DurableObjectState['storage'],
    private readonly getContainerState: () => Promise<{ status: string }>,
    private readonly isContainerRunning: () => boolean
  ) {}

  async get(): Promise<RuntimeIdentity | null> {
    const record =
      (await this.storage.get<RuntimeIdentityRecord>(
        CURRENT_RUNTIME_IDENTITY_STORAGE_KEY
      )) ?? null;
    if (!record) {
      return null;
    }

    const state = await this.getContainerState();
    if (state.status !== 'healthy' || !this.isContainerRunning()) {
      return null;
    }

    return new RuntimeIdentity(record);
  }

  async markStarted(): Promise<RuntimeIdentity> {
    const record: RuntimeIdentityRecord = {
      id: runtimeIdentityID(crypto.randomUUID()),
      startedAt: Date.now()
    };
    await this.storage.put(CURRENT_RUNTIME_IDENTITY_STORAGE_KEY, record);
    return new RuntimeIdentity(record);
  }

  async clear(): Promise<void> {
    await this.storage.delete(CURRENT_RUNTIME_IDENTITY_STORAGE_KEY);
  }

  async isActive(runtime: RuntimeIdentity): Promise<boolean> {
    const current = await this.get();
    return current?.id === runtime.id;
  }

  async assertActive(runtime: RuntimeIdentity): Promise<void> {
    if (!(await this.isActive(runtime))) {
      throw new Error('Runtime identity is no longer active');
    }
  }
}
