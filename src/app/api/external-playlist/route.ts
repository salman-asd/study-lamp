import { NextResponse } from "next/server";
import { fetchExternalPlaylistPreview } from "@/lib/video-platforms/playlist";
import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { logServerError } from "@/lib/server/logError";

// Platform-agnostic sibling of /api/youtube-playlist (left untouched for
// backward compatibility). fetchExternalPlaylistPreview already dispatches
// to whichever ExternalPlaylistProvider matches the pasted URL — YouTube
// playlist, Facebook collection, or any provider added later — so this
// route needs no per-platform branching, and no changes when a new
// provider is added to externalPlaylistProviders. Kept behind
// authentication for the same reason as the YouTube route: an unauthenticated
// endpoint would let anonymous traffic burn through server-side API quota
// (YouTube Data API key, Facebook Page access token).
export const GET = withAuthedRoute(async ({ req }) => {
  const rawUrl = req.nextUrl.searchParams.get("url");
  if (!rawUrl || !rawUrl.trim()) {
    return NextResponse.json({ error: "Missing playlist/collection URL" }, { status: 400 });
  }

  try {
    const preview = await fetchExternalPlaylistPreview(rawUrl);
    return NextResponse.json({
      provider: preview.provider,
      title: preview.title,
      description: preview.description || "",
      thumbnailUrl: preview.thumbnailUrl || "",
      sourceUrl: preview.sourceUrl,
      totalVideos: preview.totalVideos,
      unavailableCount: preview.unavailableCount,
      videos: preview.videos.map((video) => ({
        title: video.title,
        youtubeVideoId: video.youtubeVideoId || null,
        videoUrl: video.videoUrl,
        thumbnailUrl: video.thumbnailUrl || "",
        durationSeconds: typeof video.durationSeconds === "number" ? video.durationSeconds : null,
        platform: video.platform,
        order: video.order,
      })),
    });
  } catch (err) {
    logServerError("External playlist fetch failed", err);
    return NextResponse.json({ error: "Failed to fetch playlist/collection" }, { status: 500 });
  }
}, { scope: "external-playlist" });
