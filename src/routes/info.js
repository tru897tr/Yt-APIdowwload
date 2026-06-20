import { Router } from "express";
import { fetchVideoInfo, isValidYoutubeUrl } from "../services/ytdlp.js";

export const infoRouter = Router();

/**
 * GET /api/info?url=<youtube_url>
 * Trả về metadata video + danh sách quality khả dụng.
 */
infoRouter.get("/info", async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Missing required query param: url" });
  }

  if (!isValidYoutubeUrl(url)) {
    return res.status(400).json({ error: "Invalid YouTube URL" });
  }

  try {
    const info = await fetchVideoInfo(url);
    return res.json({ success: true, data: info });
  } catch (err) {
    console.error("[/api/info] error:", err.message);
    return res.status(502).json({
      error: "Failed to fetch video info",
      detail: err.message,
    });
  }
});
