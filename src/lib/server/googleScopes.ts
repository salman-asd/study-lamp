export type GoogleWorkspaceFeature = "calendar" | "tasks";

export const GOOGLE_WORKSPACE_SCOPES: Record<GoogleWorkspaceFeature, string> = {
  calendar: "https://www.googleapis.com/auth/calendar.app.created",
  tasks: "https://www.googleapis.com/auth/tasks",
};

export const GOOGLE_USERINFO_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";

export function scopesForFeatures(features: readonly GoogleWorkspaceFeature[]): string[] {
  const normalized = Array.from(new Set(features.filter((feature): feature is GoogleWorkspaceFeature => feature === "calendar" || feature === "tasks")));
  const scopes = normalized.map((feature) => GOOGLE_WORKSPACE_SCOPES[feature]);
  if (!scopes.includes(GOOGLE_USERINFO_EMAIL_SCOPE)) {
    scopes.push(GOOGLE_USERINFO_EMAIL_SCOPE);
  }
  return scopes;
}

export function featuresFromGrantedScopes(scopeString: string | null | undefined): GoogleWorkspaceFeature[] {
  const granted = new Set<GoogleWorkspaceFeature>();
  for (const scope of (scopeString ?? "").split(/\s+/).filter(Boolean)) {
    if (scope === GOOGLE_WORKSPACE_SCOPES.calendar) granted.add("calendar");
    if (scope === GOOGLE_WORKSPACE_SCOPES.tasks) granted.add("tasks");
  }
  return Array.from(granted);
}

export function missingFeatures(requested: readonly GoogleWorkspaceFeature[], scopeString: string | null | undefined): GoogleWorkspaceFeature[] {
  const granted = new Set(featuresFromGrantedScopes(scopeString));
  return requested.filter((feature) => !granted.has(feature));
}
