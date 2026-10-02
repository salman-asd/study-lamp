export interface DriveTiming {
  measure<T>(stage: string, operation: () => Promise<T>): Promise<T>;
  log(): void;
}

export function createDriveTiming(route: string): DriveTiming {
  const enabled = process.env.DRIVE_TIMING === "1";
  const stages: Record<string, number> = {};

  return {
    async measure<T>(stage: string, operation: () => Promise<T>): Promise<T> {
      if (!enabled) return operation();
      const startedAt = process.hrtime.bigint();
      try {
        return await operation();
      } finally {
        stages[stage] = (stages[stage] ?? 0) + Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      }
    },
    log() {
      if (enabled) console.info(`[drive-timing] ${route} ${JSON.stringify(stages)}`);
    },
  };
}