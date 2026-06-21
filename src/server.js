import express from "express";
import cors from "cors";
import morgan from "morgan";
import fs from "fs";

import { CONFIG } from "./config.js";
import { ensureDownloadDir, startCleanupCron, cleanupExpired } from "./services/storage.js";
import { infoRouter } from "./routes/info.js";
import { downloadRouter } from "./routes/download.js";
import { healthRouter } from "./routes/health.js";

const app = express();

app.use(cors());
app.use(morgan("combined"));
app.use(express.json());

app.use("/api", healthRouter);
app.use("/api", infoRouter);
app.use("/api", downloadRouter);

app.get("/", (req, res) => {
  res.json({
    name: "YouTube Downloader API",
    status: "running",
    docs: "Xem README.md / API_DOCS.md trong gói tải về",
    endpoints: {
      info: "GET /api/info?url=<youtube_url>",
      download: "GET /api/download?url=<youtube_url>&quality=720&mode=stream|link",
      file: "GET /api/download/file/:jobId",
      status: "GET /api/download/status/:jobId",
      health: "GET /api/health",
    },
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler cuối cùng (bắt lỗi không mong muốn)
app.use((err, req, res, next) => {
  console.error("[unhandled]", err);
  res.status(500).json({ error: "Internal server error" });
});

ensureDownloadDir();
cleanupExpired(); // dọn rác từ lần chạy trước (nếu container restart)
startCleanupCron();

app.listen(CONFIG.PORT, () => {
  console.log(`🚀 YouTube Downloader API running on port ${CONFIG.PORT}`);
  console.log(`   Download dir: ${CONFIG.DOWNLOAD_DIR}`);
  console.log(`   File TTL: ${CONFIG.FILE_TTL_HOURS}h`);

  if (CONFIG.COOKIES_PATH) {
    const exists = fs.existsSync(CONFIG.COOKIES_PATH);
    console.log(`   Cookies path: ${CONFIG.COOKIES_PATH} (exists=${exists})`);
    if (!exists) {
      console.warn(
        `   ⚠️  COOKIES_PATH is set but the file was not found at startup. ` +
          `Check your Render Secret File name/path.`
      );
    }
  } else {
    console.log(`   Cookies path: not configured (COOKIES_PATH env var not set)`);
  }

  // In luôn danh sách file thực tế trong /etc/secrets để dễ đối chiếu khi debug trên Render
  try {
    if (fs.existsSync("/etc/secrets")) {
      console.log(`   /etc/secrets contents: ${fs.readdirSync("/etc/secrets").join(", ") || "(empty)"}`);
    }
  } catch {
    /* ignore */
  }
});
