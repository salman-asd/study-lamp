// Shared by client and server. Pure — no Node APIs, no secrets, no imports
// from server-only modules, so this file is safe to bundle into the browser.
//
// Step W2 (Workspace connection foundation). Study Lamp asks Google for the
// narrowest scopes that let it manage only what it creates:
//   calendar -> calendar.app.created (only calendars/events Study Lamp made)
//   tasks    -> tasks                (only tasks Study Lamp made/lists)
// The userinfo.email scope is always requested so the callback can show which
// Google account was connected; it grants no additional data access.

export type GoogleWorkspaceFeature = "calendar" | "tasks";

export const GOOGLE_WORKSPACE_SCOPES: Record<GoogleWorkspaceFeature, string> = {
  calendar: "https://www.googleapis.com/auth/calendar.app.created",
  tasks: "https://www.googleapis.com/auth/tasks",
};

export const GOOGLE_USERINFO_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";

function isWorkspaceFeature(value: unknown): value is GoogleWorkspaceFeature {
  return value === "calendar" || value === "tasks";
}

/** The exact scope list to request for the given features, always including
 *  userinfo.email. Order is stable and duplicates are removed. */
export function scopesForFeatures(features: readonly GoogleWorkspaceFeature[]): string[] {
  const normalized = Array.from(new Set(features.filter(isWorkspaceFeature)));
  const scopes = normalized.map((feature) => GOOGLE_WORKSPACE_SCOPES[feature]);
  if (!scopes.includes(GOOGLE_USERINFO_EMAIL_SCOPE)) {
    scopes.push(GOOGLE_USERINFO_EMAIL_SCOPE);
  }
  return scopes;
}

/** Parses the space-separated `scope` string Google returns from the token
 *  endpoint into the features Study Lamp actually got. Unknown scopes (for
 *  example anything granted previously) are ignored. */
export function featuresFromGrantedScopes(scopeString: string | null | undefined): GoogleWorkspaceFeature[] {
  const granted = new Set<GoogleWorkspaceFeature>();
  for (const scope of (scopeString ?? "").split(/\s+/).filter(Boolean)) {
    if (scope === GOOGLE_WORKSPACE_SCOPES.calendar) granted.add("calendar");
    if (scope === GOOGLE_WORKSPACE_SCOPES.tasks) granted.add("tasks");
  }
  return Array.from(granted);
}

/** Which of the requested features were NOT granted. Used by the callback to
 *  report a partial grant (the user unticking a box on Google's consent
 *  screen) back to the settings page as ?missing=… */
export function missingFeatures(
  requested: readonly GoogleWorkspaceFeature[],
  scopeString: string | null | undefined,
): GoogleWorkspaceFeature[] {
  const granted = new Set(featuresFromGrantedScopes(scopeString));
  return Array.from(new Set(requested.filter(isWorkspaceFeature))).filter((feature) => !granted.has(feature));
}
