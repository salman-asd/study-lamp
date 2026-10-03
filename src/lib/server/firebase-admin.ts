import admin from "firebase-admin";

let warnedDemo = false;

/**
 * Initialises the Admin SDK on first use, not at import time, so `next build`
 * (which imports every route module) works without Firebase secrets. In
 * production a route that actually needs Admin fails with a clear error;
 * outside production a missing config falls back to a "demo-project" app and
 * logs one warning.
 */
function getAdminApp(): admin.app.App {
  if (admin.apps.length) return admin.app();

  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (projectId && clientEmail && privateKey) {
    return admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }), projectId });
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY must be configured in production.");
  }
  if (!warnedDemo) {
    warnedDemo = true;
    console.warn("Firebase Admin is not configured; using the demo-project fallback (development only).");
  }
  // Fail closed: without credentials ID tokens cannot be verified, so authenticated routes reject requests.
  return admin.initializeApp({ projectId: projectId || "demo-project" });
}

export function getAdminAuth(): admin.auth.Auth {
  return getAdminApp().auth();
}

export function getAdminDb(): admin.firestore.Firestore {
  return getAdminApp().firestore();
}

/**
 * Same exports as before (`adminAuth`, `adminDb`), so no caller changes: each
 * property access resolves the lazily initialised service. Methods are bound to
 * the real instance.
 */
function lazy<T extends object>(get: () => T): T {
  return new Proxy({} as T, {
    get(_target, property) {
      const instance = get() as any;
      const value = instance[property];
      return typeof value === "function" ? value.bind(instance) : value;
    },
  });
}

export const adminAuth = lazy(getAdminAuth);
export const adminDb = lazy(getAdminDb);
