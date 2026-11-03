export class HostError extends Error {
  constructor(
    readonly code: string,
    readonly subject?: string,
  ) {
    super(subject === undefined ? code : `${code}: ${subject}`);
    this.name = 'HostError';
  }
}

export class TargetSelectionRequired extends HostError {
  constructor(readonly targetIds: readonly string[]) {
    super('TARGET_SELECTION_REQUIRED');
  }
}
