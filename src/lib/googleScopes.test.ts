import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GOOGLE_USERINFO_EMAIL_SCOPE,
  GOOGLE_WORKSPACE_SCOPES,
  featuresFromGrantedScopes,
  missingFeatures,
  scopesForFeatures,
} from "./googleScopes";

describe("googleScopes", () => {
  it("builds the scope list for a feature and always includes userinfo.email", () => {
    assert.deepEqual(scopesForFeatures(["calendar"]), [
      GOOGLE_WORKSPACE_SCOPES.calendar,
      GOOGLE_USERINFO_EMAIL_SCOPE,
    ]);
  });

  it("de-duplicates features and keeps a stable order", () => {
    assert.deepEqual(scopesForFeatures(["tasks", "calendar", "tasks"]), [
      GOOGLE_WORKSPACE_SCOPES.tasks,
      GOOGLE_WORKSPACE_SCOPES.calendar,
      GOOGLE_USERINFO_EMAIL_SCOPE,
    ]);
  });

  it("returns only userinfo.email when no feature is requested", () => {
    assert.deepEqual(scopesForFeatures([]), [GOOGLE_USERINFO_EMAIL_SCOPE]);
  });

  it("parses granted features from a space-separated scope string", () => {
    const scope = `${GOOGLE_WORKSPACE_SCOPES.calendar} ${GOOGLE_USERINFO_EMAIL_SCOPE}`;
    assert.deepEqual(featuresFromGrantedScopes(scope), ["calendar"]);
  });

  it("ignores unknown scopes and handles null/empty input", () => {
    assert.deepEqual(featuresFromGrantedScopes(null), []);
    assert.deepEqual(featuresFromGrantedScopes(""), []);
    assert.deepEqual(featuresFromGrantedScopes("https://www.googleapis.com/auth/drive.file"), []);
  });

  it("reports which requested features were not granted (partial grant)", () => {
    const scope = GOOGLE_WORKSPACE_SCOPES.calendar;
    assert.deepEqual(missingFeatures(["calendar", "tasks"], scope), ["tasks"]);
    assert.deepEqual(missingFeatures(["calendar"], scope), []);
  });
});