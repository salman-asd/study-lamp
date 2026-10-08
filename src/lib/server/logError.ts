export function logServerError(label: string, err: unknown): void {
  const name = err instanceof Error ? err.name : typeof err;
  const status = typeof err === "object" && err !== null && "status" in err && typeof (err as { status?: unknown }).status === "number"
    ? ` status=${(err as { status: number }).status}`
    : "";
  // gRPC / Node error codes (for example Firestore 9 = FAILED_PRECONDITION = missing index).
  // Only a number or a short identifier is logged, never the message.
  const rawCode = typeof err === "object" && err !== null && "code" in err ? (err as { code?: unknown }).code : undefined;
  const code = typeof rawCode === "number" || (typeof rawCode === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(rawCode))
    ? ` code=${rawCode}`
    : "";

  console.error(`${label}: ${name}${status}${code}`);
}
