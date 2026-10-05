/**
 * Re-encrypts every stored credential with the CURRENT AI_CONNECTION_ENCRYPTION_KEY.
 *
 *   npx tsx scripts/reencrypt.ts           # dry run (default): decrypts + re-encrypts in memory, writes nothing
 *   npx tsx scripts/reencrypt.ts --apply   # writes the re-encrypted values
 *
 * Needs AI_CONNECTION_ENCRYPTION_KEY (new) and AI_CONNECTION_ENCRYPTION_KEY_PREVIOUS (old) plus the
 * FIREBASE_* admin variables in the environment. See docs/security.md.
 * Output is counts only: never keys, plaintext or ciphertext.
 */
import { adminDb } from "../src/lib/server/firebase-admin";
import { decryptApiKey, encryptApiKey } from "../src/lib/server/aiEncryption";

type Label = "aiConnections" | "driveConnections" | "googleConnections" | "systemAiConnections";
const LABELS: Label[] = ["aiConnections", "driveConnections", "googleConnections", "systemAiConnections"];

interface EncryptedField {
  label: Label;
  ref: FirebaseFirestore.DocumentReference;
  field: "encryptedApiKey" | "encryptedRefreshToken";
  value: unknown;
}

async function loadEncryptedFields(): Promise<EncryptedField[]> {
  const encrypted: EncryptedField[] = [];

  // listDocuments() returns refs only (no user data is downloaded) and includes users without a profile doc.
  const userRefs = await adminDb.collection("users").listDocuments();
  for (const userRef of userRefs) {
    for (const label of ["aiConnections", "driveConnections", "googleConnections"] as const) {
      const field = label === "aiConnections" ? "encryptedApiKey" : "encryptedRefreshToken";
      const snapshot = await userRef.collection(label).get();
      for (const document of snapshot.docs) {
        encrypted.push({ label, ref: document.ref, field, value: document.get(field) });
      }
    }
  }

  const systemConnections = await adminDb.collection("systemAiConnections").get();
  for (const document of systemConnections.docs) {
    encrypted.push({ label: "systemAiConnections", ref: document.ref, field: "encryptedApiKey", value: document.get("encryptedApiKey") });
  }

  return encrypted;
}

async function main() {
  const flags = process.argv.slice(2);
  const unknown = flags.filter((flag) => flag !== "--apply" && flag !== "--dry-run");
  if (unknown.length > 0) throw new Error(`Unknown option(s): ${unknown.join(", ")}. Use --apply to write; the default is a dry run.`);
  if (flags.includes("--apply") && flags.includes("--dry-run")) throw new Error("Use either --apply or --dry-run, not both.");
  const apply = flags.includes("--apply");

  if (!process.env.AI_CONNECTION_ENCRYPTION_KEY) {
    throw new Error("Set AI_CONNECTION_ENCRYPTION_KEY to the new key before running this script.");
  }

  console.log(apply ? "Mode: APPLY (will write)." : "Mode: DRY RUN (no writes). Pass --apply to write.");

  const fields = await loadEncryptedFields();
  const total: Record<Label, number> = { aiConnections: 0, driveConnections: 0, googleConnections: 0, systemAiConnections: 0 };
  const failed: Record<Label, number> = { aiConnections: 0, driveConnections: 0, googleConnections: 0, systemAiConnections: 0 };
  const updates: Array<{ ref: FirebaseFirestore.DocumentReference; field: string; encrypted: string }> = [];

  for (const { label, ref, field, value } of fields) {
    total[label]++;
    try {
      if (typeof value !== "string") throw new Error("missing");
      const plaintext = decryptApiKey(value);
      const encrypted = encryptApiKey(plaintext);
      // Round-trip check so a bad write can never replace a good credential.
      if (decryptApiKey(encrypted) !== plaintext) throw new Error("round-trip");
      updates.push({ ref, field, encrypted });
    } catch {
      failed[label]++; // Reason deliberately not printed: messages could hint at key material.
    }
  }

  for (const label of LABELS) {
    console.log(`${label}: ${total[label]} found, ${total[label] - failed[label]} ok, ${failed[label]} failed`);
  }

  const failures = LABELS.reduce((sum, label) => sum + failed[label], 0);
  if (failures > 0) {
    console.error(`${failures} credential(s) could not be decrypted/re-encrypted. Nothing was written.`);
    process.exitCode = 1;
    return;
  }

  if (!apply) {
    console.log(`Dry run passed. ${updates.length} credentials can be re-encrypted. Re-run with --apply to write.`);
    return;
  }

  for (let offset = 0; offset < updates.length; offset += 400) {
    const batch = adminDb.batch();
    for (const update of updates.slice(offset, offset + 400)) {
      batch.update(update.ref, { [update.field]: update.encrypted });
    }
    await batch.commit();
  }

  console.log(`Re-encrypted ${updates.length} stored credentials.`);
}

main().catch((error: unknown) => {
  console.error("Credential re-encryption failed.", error instanceof Error ? error.message : "Unknown error.");
  process.exitCode = 1;
});
