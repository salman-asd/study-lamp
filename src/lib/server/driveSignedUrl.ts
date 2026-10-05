import crypto from "crypto";
import { isValidDriveConnectionId, isValidDriveId } from "@/lib/server/googleDrive";

export type DriveUrlPurpose = "stream" | "download" | "thumb" | "export" | "export_download";

export interface DriveSignedUrlInput {
  uid: string;
  fileId: string;
  connectionId: string;
  purpose: DriveUrlPurpose;
}

export interface DriveSignedUrlVerification extends DriveSignedUrlInput {
  exp: number;
  sig: string;
}

export const DRIVE_URL_TTL_SECONDS: Record<DriveUrlPurpose, number> = {
  stream: 6 * 60 * 60,
  download: 10 * 60,
  thumb: 24 * 60 * 60,
  export: 30 * 60,
  export_download: 10 * 60,
};

// A signed URL is a bearer capability until exp. Disconnecting the Drive
// account revokes its Google credentials, so subsequent proxy requests cannot
// refresh or use access once Google rejects the revoked connection.

function signingSecret(): string {
  const secret = process.env.DRIVE_URL_SIGNING_SECRET;
  if (!secret) throw new Error("DRIVE_URL_SIGNING_SECRET is not configured.");
  return secret;
}

function signature(input: DriveSignedUrlInput, exp: number): Buffer {
  const payload = `v1|${input.purpose}|${input.uid}|${input.connectionId}|${input.fileId}|${exp}`;
  return crypto.createHmac("sha256", signingSecret()).update(payload).digest();
}

export function signDriveUrl(input: DriveSignedUrlInput, nowMs = Date.now()): { exp: number; sig: string } {
  if (!input.uid || !isValidDriveId(input.fileId) || !isValidDriveConnectionId(input.connectionId)) {
    throw new Error("Invalid Drive URL signing input.");
  }
  const exp = Math.floor(nowMs / 1000) + DRIVE_URL_TTL_SECONDS[input.purpose];
  return { exp, sig: signature(input, exp).toString("base64url") };
}

export function verifyDriveUrl(input: DriveSignedUrlVerification, nowMs = Date.now()): boolean {
  try {
    if (!input.uid || !isValidDriveId(input.fileId) || !isValidDriveConnectionId(input.connectionId)) return false;
    if (!(input.purpose in DRIVE_URL_TTL_SECONDS) || !Number.isSafeInteger(input.exp)) return false;
    const nowSeconds = Math.floor(nowMs / 1000);
    if (input.exp <= nowSeconds || input.exp > nowSeconds + DRIVE_URL_TTL_SECONDS[input.purpose]) return false;

    const supplied = Buffer.from(input.sig, "base64url");
    const expected = signature(input, input.exp);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  } catch {
    return false;
  }
}