import { NextResponse } from "next/server";
import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { logServerError } from "@/lib/server/logError";
import { isAllowedFacebookUrl, resolveFacebookRedirectUrl, fetchFacebookVideoOEmbed } from "@/lib/video-platforms/facebookGraph";
import { detectVideoProvider, generateCanonicalUrl, generateFacebookAlternateUrl, generateFacebookOEmbedUrl } from "@/lib/video-platforms";

// Runs server-side so short-link redirect resolution has a stable place to
// live, same as YOUTUBE_API_KEY-backed lookups staying server-side in
// /api/youtube-duration. Two jobs: (1) resolve a short share link
// (fb.watch, /share/v/) to its canonical, ID-bearing URL via a plain
// redirect follow (no Graph API needed for this part); (2) fetch
// title/thumbnail/author via the Graph API's tokenless oEmbed Video
// endpoint (no app credentials needed as of Meta's 15 June 2026 change —
// see facebookGraph.ts).
// Returns `{ metadata: null }` (not an error) whenever the video can't be
// resolved — a private video or Facebook simply declining to serve full
// oEmbed for that URL — so the client falls back to the same manual-entry
// UX already used elsewhere for unfetchable metadata, rather than
// surfacing a scary error for an expected case.
export const GET = withAuthedRoute(async ({ req }) => {
  const rawUrl = req.nextUrl.searchParams.get("url");
  if (!rawUrl) {
    return NextResponse.json({ error: "Missing url" }, { status: 400 });
  }
  if (!isAllowedFacebookUrl(rawUrl)) {
    return NextResponse.json({ error: "A valid HTTPS Facebook video URL is required." }, { status: 400 });
  }

  try {
    // Keep the URL actually carrying the ID (rawUrl, or the redirect
    // target for short links) separate from canonicalUrl below.
    // canonicalUrl() is Reel-aware (see FacebookVideoProvider.canonicalUrl
    // in providers.ts): a Reel normalizes to `/reel/{id}/`, anything else
    // to `/watch/?v={id}`. That single shape is what's used consistently
    // for oEmbed, storage, and (later, client-side) the player embed —
    // do NOT reintroduce a second place that forces `/watch/?v=` for
    // Reels, that mismatch is exactly what caused newly-saved Reels to
    // oEmbed fine but render a black player.
    let sourceUrl = rawUrl;
    let canonicalUrl = generateCanonicalUrl(rawUrl);

    // A short share link normalizes with no canonical URL yet (see
    // FacebookVideoProvider.normalize) — resolve the redirect server-side,
    // then re-run detection against the resolved URL.
    if (!canonicalUrl) {
      const resolved = await resolveFacebookRedirectUrl(rawUrl);
      if (resolved) {
        const resolvedProvider = detectVideoProvider(resolved);
        if (resolvedProvider?.platform === "facebook") {
          sourceUrl = resolved;
          canonicalUrl = generateCanonicalUrl(resolved);
        }
      }
    }

    if (!canonicalUrl) {
      return NextResponse.json({ metadata: null, canonicalUrl: null });
    }

    const oEmbedUrl = generateFacebookOEmbedUrl(sourceUrl) || canonicalUrl;
    // canonicalUrl is also what gets scraped for Open Graph tags. That
    // fetch isn't shape-sensitive the way the oEmbed call is (a Reel's
    // /reel/ page and a video's /watch/ page both carry normal og:* meta
    // tags), so reusing the same Reel-aware canonicalUrl here is fine and
    // — since it's now the actual public URL for the video rather than an
    // always-/watch/ rewrite — is if anything more likely to match what
    // Facebook serves for that specific post.
    const metadata = await fetchFacebookVideoOEmbed(oEmbedUrl, canonicalUrl);

    // Defensive retry: some Reels' primary shape comes back with nothing
    // usable (oEmbed declines, OG-tag scrape empty) even though the same
    // video id is also reachable — and fully describable — under its
    // alternate shape (a Reel's /watch/?v= alias, or vice versa). Only
    // retried for a genuinely empty result (no title at all) — this never
    // touches `canonicalUrl` itself, so storage and the player embed still
    // get the original, correct-for-playback shape either way.
    let finalMetadata = metadata;
    if (!metadata || metadata.title === "Untitled video") {
      const alternateUrl = generateFacebookAlternateUrl(sourceUrl);
      if (alternateUrl) {
        const alternateMetadata = await fetchFacebookVideoOEmbed(alternateUrl, alternateUrl);
        if (alternateMetadata && alternateMetadata.title !== "Untitled video") {
          // Keep the primary thumbnail if the alternate fetch didn't find
          // one of its own — no reason to throw away a working thumbnail
          // just because the title came from a different shape's fetch.
          finalMetadata = {
            ...alternateMetadata,
            thumbnailUrl: alternateMetadata.thumbnailUrl || metadata?.thumbnailUrl || null,
          };
        } else {
        }
      }
    }

    return NextResponse.json({ metadata: finalMetadata, canonicalUrl });
  } catch (err) {
    // Metadata is best-effort for Facebook (see facebookGraph.ts) — a
    // thrown error here still degrades to manual entry rather than
    // blocking the add-video flow.
    logServerError("Facebook video metadata lookup failed", err);
    return NextResponse.json({ metadata: null, canonicalUrl: null, error: "Failed to fetch Facebook video metadata" });
  }
}, { scope: "facebook-video" });