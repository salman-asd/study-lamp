# Security Operations

## Rotate encrypted AI and Drive credentials

`AI_CONNECTION_ENCRYPTION_KEY` encrypts both user/system AI API keys and Google Drive refresh tokens. Do not replace it without retaining the old key until every stored credential has been re-encrypted.

1. Back up Firestore and generate a new base64-encoded 32-byte key.
2. Set `AI_CONNECTION_ENCRYPTION_KEY` to the new key and `AI_CONNECTION_ENCRYPTION_KEY_PREVIOUS` to the existing key in the deployment environment. Deploy/restart the application so reads can use either key and new writes use the new key.
3. Run `npx tsx scripts/reencrypt.ts --dry-run` with the new key as current and the old key as previous. The script decrypts all credentials before making any writes; the dry run reports only a count.
4. If the dry run passes, run `npx tsx scripts/reencrypt.ts`. It updates `users/*/aiConnections`, `users/*/driveConnections`, and `systemAiConnections` in batches. The output contains counts only, never credential values.
5. Verify AI connections and Drive connections in the application. Then remove `AI_CONNECTION_ENCRYPTION_KEY_PREVIOUS` from the deployment environment and restart/redeploy.

Keep the old key in a secure, temporary recovery location until verification is complete. Never put either key in source control, logs, or a command-history-visible literal.