import type { GoogleSyncHistoryEntry } from "@/types";

/** Plain-language lines for the read-only "Recent changes" list (W5). Pure. */

const DIRECTION_WORDS: Record<string, string> = {
  study_lamp_to_google: "Study Lamp → Google",
  google_to_study_lamp: "Google → Study Lamp",
  both: "Both ways",
  study_lamp: "Study Lamp",
};

const RESULT_WORDS: Record<GoogleSyncHistoryEntry["result"], string> = {
  applied: "Applied",
  stale: "Changed since preview",
  skipped: "Skipped",
  failed: "Failed",
};

const KIND_WORDS: Record<string, string> = {
  push_create: "Added to Google",
  push_update: "Updated in Google",
  pull_update: "Updated here from Google",
  pull_create: "Imported as a goal",
  conflict: "Resolved a difference",
  remote_deleted: "Event or task deleted in Google",
  remove: "Removed from Google",
};

function show(value: string | boolean | null): string {
  if (value === null) return "(none)";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return value === "" ? "(empty)" : value.length > 60 ? `${value.slice(0, 57)}…` : value;
}

export function describeHistoryEntry(entry: GoogleSyncHistoryEntry): { title: string; meta: string; changes: string[] } {
  const service = entry.scope === "tasks" ? "Tasks" : "Calendar";
  const kind = KIND_WORDS[entry.itemKind] ?? "Change";
  const direction = DIRECTION_WORDS[entry.direction] ?? entry.direction;
  const when = Number.isNaN(Date.parse(entry.at)) ? "" : new Date(entry.at).toLocaleString();
  return {
    title: entry.titleSnapshot || "(untitled goal)",
    meta: [when, service, kind, direction, RESULT_WORDS[entry.result] ?? entry.result].filter(Boolean).join(" · "),
    changes: entry.fields.slice(0, 5).map((field) => `${field.name}: ${show(field.before)} → ${show(field.after)}`),
  };
}
