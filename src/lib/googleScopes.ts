// Shared by client and server. Pure — no Node APIs, no secrets, no imports
// from server-only modules, so this file is safe to bundle into the browser.
//
// Step W2 (Workspace connection foundation). Study Lamp asks Google for the
// narrowest scopes that exist for each service:
//   calendar -> calendar.app.created (only calendars/events Study Lamp made)
//   tasks    -> tasks                (NOT narrow: Google has no app-created
//                                     scope for Tasks, so this grants read and
//                                     write access to ALL of the user's task
//                                     lists, not only the "Study Lamp" list)
// Because the Tasks grant is wider than the feature needs, the limit is
// enforced in OUR code: every Tasks call takes the stored Study Lamp list id,
// and the client exposes no way to list or touch other lists (pinned by a test
// in googleTasks.test.ts). The consent copy and docs must say this plainly.
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
