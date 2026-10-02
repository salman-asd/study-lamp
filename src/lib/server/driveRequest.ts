export async function runWithDriveToken<T>(
  getToken: () => Promise<string>,
  invalidate: () => void,
  operation: (token: string) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken();
    try {
      const result = await operation(token);
      const unauthorizedResponse = typeof Response !== "undefined" && result instanceof Response && result.status === 401;
      if (!unauthorizedResponse) return result;
      invalidate();
      if (attempt === 1) return result;
    } catch (error) {
      const status = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
      if (status !== 401) throw error;
      invalidate();
      if (attempt === 1) throw error;
    }
  }
  throw new Error("Drive request retry ended unexpectedly.");
}