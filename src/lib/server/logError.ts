export function logServerError(label: string, err: unknown): void {
  const name = err instanceof Error ? err.name : typeof err;
  const status = typeof err === "object" && err !== null && "status" in err && typeof (err as { status?: unknown }).status === "number"
    ? ` status=${(err as { status: number }).status}`
    : "";

  console.error(`${label}: ${name}${status}`);
}
