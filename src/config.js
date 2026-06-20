import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

export const CONFIG = {
  PORT: process.env.PORT || 3000,

  // Thư mục lưu file tải tạm thời
  DOWNLOAD_DIR: process.env.DOWNLOAD_DIR || path.join(ROOT_DIR, "downloads"),

  // Thời gian (giờ) trước khi file tự bị xoá
  FILE_TTL_HOURS: Number(process.env.FILE_TTL_HOURS || 12),

  // Chu kỳ (phút) chạy cron quét và xoá file quá hạn
  CLEANUP_INTERVAL_MINUTES: Number(process.env.CLEANUP_INTERVAL_MINUTES || 30),

  // Đường dẫn tới binary yt-dlp (đã cài qua pip trong Dockerfile)
  YTDLP_PATH: process.env.YTDLP_PATH || "yt-dlp",

  // Public base URL để build link download (Render sẽ set qua env RENDER_EXTERNAL_URL)
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || null,

  // Giới hạn dung lượng video tối đa cho phép tải (MB) - bảo vệ disk free tier
  MAX_FILE_SIZE_MB: Number(process.env.MAX_FILE_SIZE_MB || 500),

  // Timeout cho 1 lần tải (ms)
  DOWNLOAD_TIMEOUT_MS: Number(process.env.DOWNLOAD_TIMEOUT_MS || 5 * 60 * 1000),
};
