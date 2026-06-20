import { Router } from "express";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { CONFIG } from "../config.js";
import { downloadVideo, isValidYoutubeUrl, fetchVideoInfo } from "../services/ytdlp.js";
import { registerFile, getFile } from "../services/storage.js";

export const downloadRouter = Router();

function sanitizeFilename(name) {
  return name.replace(/[^\w\-\s.]/g, "").trim().slice(0, 80) || "video";
}

function buildPublicUrl(req, jobId) {
  const base = CONFIG.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
  return `${base.replace(/\/$/, "")}/api/download/file/${jobId}`;
}

/**
 * GET /api/download?url=<youtube_url>&quality=720&mode=stream|link
 *
 * mode=stream (default): tải xong stream file thẳng về client, response là file video.
 * mode=link: tải xong lưu trên server, trả về JSON gồm link tạm (sống trong FILE_TTL_HOURS).
 */
downloadRouter.get("/download", async (req, res) => {
  const { url, quality = "best", mode = "stream" } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Missing required query param: url" });
  }
  if (!isValidYoutubeUrl(url)) {
    return res.status(400).json({ error: "Invalid YouTube URL" });
  }
  if (!["stream", "link"].includes(mode)) {
    return res.status(400).json({ error: "mode must be 'stream' or 'link'" });
  }

  const jobId = uuidv4();
  const outputTemplate = path.join(CONFIG.DOWNLOAD_DIR, `${jobId}.%(ext)s`);

  try {
    // Lấy title trước để đặt tên file thân thiện (best-effort, không chặn nếu lỗi)
    let title = "video";
    try {
      const info = await fetchVideoInfo(url);
      title = sanitizeFilename(info.title || "video");
    } catch {
      /* bỏ qua, dùng tên mặc định */
    }

    const filepath = await downloadVideo({ url, quality, outputTemplate });

    registerFile(jobId, filepath, { title });

    if (mode === "link") {
      const stat = fs.statSync(filepath);
      return res.json({
        success: true,
        job_id: jobId,
        title,
        filesize_mb: Math.round((stat.size / 1024 / 1024) * 10) / 10,
        download_url: buildPublicUrl(req, jobId),
        expires_in_hours: CONFIG.FILE_TTL_HOURS,
      });
    }

    // mode=stream: trả file ngay, KHÔNG xoá ngay sau đó - vẫn giữ lại để
    // tuân thủ rule "lưu tạm 12h rồi tự xoá" áp dụng đồng nhất cho mọi mode.
    const downloadName = `${title}.mp4`;
    return res.download(filepath, downloadName, (err) => {
      if (err) console.error("[/api/download] stream send error:", err.message);
    });
  } catch (err) {
    console.error("[/api/download] error:", err.message);
    return res.status(502).json({
      error: "Failed to download video",
      detail: err.message,
    });
  }
});

/**
 * GET /api/download/file/:jobId
 * Dùng để client tải file theo job_id trả về từ mode=link.
 */
downloadRouter.get("/download/file/:jobId", (req, res) => {
  const { jobId } = req.params;
  const entry = getFile(jobId);

  if (!entry || !fs.existsSync(entry.filepath)) {
    return res.status(404).json({ error: "File not found or already expired" });
  }

  const downloadName = `${entry.title || "video"}.mp4`;
  return res.download(entry.filepath, downloadName);
});

/**
 * GET /api/download/status/:jobId
 * Kiểm tra file còn tồn tại / còn bao lâu hết hạn.
 */
downloadRouter.get("/download/status/:jobId", (req, res) => {
  const { jobId } = req.params;
  const entry = getFile(jobId);

  if (!entry || !fs.existsSync(entry.filepath)) {
    return res.status(404).json({ exists: false });
  }

  const ttlMs = CONFIG.FILE_TTL_HOURS * 60 * 60 * 1000;
  const remainingMs = Math.max(0, entry.createdAt + ttlMs - Date.now());

  return res.json({
    exists: true,
    title: entry.title,
    expires_in_minutes: Math.round(remainingMs / 60000),
  });
});
