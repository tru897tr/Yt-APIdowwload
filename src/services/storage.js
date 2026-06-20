import fs from "fs";
import path from "path";
import cron from "node-cron";
import { CONFIG } from "../config.js";

// In-memory registry: jobId -> { filepath, createdAt, title }
// Đủ dùng cho single-instance free-tier deploy. Nếu scale nhiều instance,
// nên thay bằng Redis hoặc DB nhẹ (sqlite) chia sẻ giữa các instance.
const registry = new Map();

export function ensureDownloadDir() {
  if (!fs.existsSync(CONFIG.DOWNLOAD_DIR)) {
    fs.mkdirSync(CONFIG.DOWNLOAD_DIR, { recursive: true });
  }
}

export function registerFile(jobId, filepath, meta = {}) {
  registry.set(jobId, {
    filepath,
    createdAt: Date.now(),
    ...meta,
  });
}

export function getFile(jobId) {
  return registry.get(jobId) || null;
}

export function deleteFile(jobId) {
  const entry = registry.get(jobId);
  if (!entry) return false;
  try {
    if (fs.existsSync(entry.filepath)) {
      fs.unlinkSync(entry.filepath);
    }
  } catch (err) {
    console.error(`[cleanup] failed to delete ${entry.filepath}:`, err.message);
  }
  registry.delete(jobId);
  return true;
}

/**
 * Quét toàn bộ registry, xoá entry nào quá TTL.
 * Đồng thời quét luôn thư mục downloads để dọn rác orphan file
 * (file tồn tại trên disk nhưng không còn trong registry, ví dụ sau khi
 * server restart làm mất in-memory registry).
 */
export function cleanupExpired() {
  const ttlMs = CONFIG.FILE_TTL_HOURS * 60 * 60 * 1000;
  const now = Date.now();

  for (const [jobId, entry] of registry.entries()) {
    if (now - entry.createdAt > ttlMs) {
      deleteFile(jobId);
      console.log(`[cleanup] removed expired job ${jobId}`);
    }
  }

  // Dọn orphan files cũ hơn TTL trên disk (an toàn theo mtime)
  try {
    const files = fs.readdirSync(CONFIG.DOWNLOAD_DIR);
    for (const file of files) {
      const fullPath = path.join(CONFIG.DOWNLOAD_DIR, file);
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > ttlMs) {
        fs.unlinkSync(fullPath);
        console.log(`[cleanup] removed orphan file ${file}`);
      }
    }
  } catch (err) {
    console.error("[cleanup] orphan scan failed:", err.message);
  }
}

export function startCleanupCron() {
  const intervalMin = CONFIG.CLEANUP_INTERVAL_MINUTES;
  // chạy mỗi N phút
  cron.schedule(`*/${intervalMin} * * * *`, () => {
    cleanupExpired();
  });
  console.log(
    `[cleanup] cron scheduled every ${intervalMin}min, TTL=${CONFIG.FILE_TTL_HOURS}h`
  );
}
