import { adminDb } from "../src/lib/server/firebase-admin";
import { decryptApiKey, encryptApiKey } from "../src/lib/server/aiEncryption";

interface EncryptedField {
  ref: FirebaseFirestore.DocumentReference;
  field: "encryptedApiKey" | "encryptedRefreshToken";
  value: string;
}

async function loadEncryptedFields(): Promise<EncryptedField[]> {
  const encrypted: EncryptedField[] = [];
  const users = await adminDb.collection("users").get();

  for (const user of users.docs) {
    for (const collectionName of ["aiConnections", "driveConnections"] as const) {
      const snapshot = await user.ref.collection(collectionName).get();
      const field = collectionName === "aiConnections" ? "encryptedApiKey" : "encryptedRefreshToken";
      for (const document of snapshot.docs) {
        const value = document.get(field);
        if (typeof value !== "string") throw new Error(`Missing encrypted credential in ${collectionName}.`);
        encrypted.push({ ref: document.ref, field, value });
      }
    }
  }

  const systemConnections = await adminDb.collection("systemAiConnections").get();
  for (const document of systemConnections.docs) {
    const value = document.get("encryptedApiKey");
    if (typeof value !== "string") throw new Error("Missing encrypted credential in systemAiConnections.");
    encrypted.push({ ref: document.ref, field: "encryptedApiKey", value });
  }

  return encrypted;
}

async function main() {
  if (!process.env.AI_CONNECTION_ENCRYPTION_KEY) {
    throw new Error("Set AI_CONNECTION_ENCRYPTION_KEY to the new key before running this script.");
  }

  const fields = await loadEncryptedFields();
  const updates = fields.map(({ ref, field, value }) => ({
    ref,
    field,
    encrypted: encryptApiKey(decryptApiKey(value)),
  }));

  if (process.argv.includes("--dry-run")) {
    console.log(`Dry run passed. ${updates.length} encrypted credentials can be re-encrypted.`);
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