# Deployment Regions and Timing

## Regions

Firestore is provisioned in `asia-south2` (Delhi), as declared in `firebase.json`. Firestore's location is fixed for this project. Vercel functions are configured for `bom1` (Mumbai) in both the Vercel project settings and `vercel.json` so deployments keep using the same region.

To change the function region, update the Vercel project's **Settings → Functions → Function Region** and the `regions` array in `vercel.json`, then deploy. Keep the Firestore database in `asia-south2`; changing the function region does not move the database.

## Function durations

The Drive stream route and all AI/document-generation API routes declare `maxDuration = 60`. This is the route's requested maximum, not a guarantee that an invocation will take 60 seconds. Vercel terminates an invocation at the lower of the route setting and the project's plan/runtime limit.

As of October 2026, Vercel's duration documentation lists up to 300 seconds on Hobby with Fluid Compute, up to 800 seconds on Pro and Enterprise, and an extended 1,800-second beta for eligible Pro/Enterprise functions. These Study Lamp routes request 60 seconds, below those caps. Confirm your team's current plan and Fluid Compute settings in Vercel before relying on longer execution windows; limits can change.

## Drive timing

Set the server-only environment variable `DRIVE_TIMING=1` in a preview or deployment to emit one `[drive-timing]` log per stream or thumbnail request. Signed URLs remove Firebase auth and Firestore ownership reads from these routes; the JSON fields record local `signature_ms`, cached/refreshed `token_ms`, and Google `upstream_ms`. Thumbnail requests also include `metadata_ms`. Timing logs contain stage durations only, not signatures, access tokens, or file contents.

To establish the S3 baseline, deploy a preview, play a Drive video, seek once, and inspect the function logs for the corresponding stream request. Record the stage timings and repeat after later Drive performance changes. Remove or disable `DRIVE_TIMING` when measurement is complete.

## Drive thumbnails

Firebase Storage is not initialized for the current project, so Drive thumbnails use the roadmap's Firestore fallback: an image data URL is stored in `thumbnailData` only when its complete encoded value is at most 40 KB. Larger or unavailable thumbnails do not fail imports; the signed proxy retries fetching them when requested. If Firebase Storage is enabled later, move thumbnail persistence to private Storage objects before relaxing the Firestore size bound.