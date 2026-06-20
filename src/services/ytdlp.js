import { spawn } from "child_process";
import { CONFIG } from "../config.js";

/**
 * Chạy yt-dlp với danh sách arguments, trả về { stdout, stderr, code }
 * Không dùng exec/shell string để tránh injection - dùng spawn với array args.
 */
function runYtDlp(args, { timeoutMs = CONFIG.DOWNLOAD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CONFIG.YTDLP_PATH, args, { windowsHide: true });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGKILL");
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        return reject(new Error("yt-dlp timed out"));
      }
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Validate rằng input là một URL YouTube hợp lệ.
 * Chặn sớm để không pass input rác / cờ ẩn vào yt-dlp.
 */
export function isValidYoutubeUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url);
    const allowedHosts = [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtu.be",
    ];
    return allowedHosts.includes(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Lấy metadata video (title, duration, thumbnail, formats khả dụng...)
 * dùng yt-dlp --dump-json (không tải file).
 */
export async function fetchVideoInfo(url) {
  const args = [
    "--dump-single-json",
    "--no-warnings",
    "--no-playlist",
    "--no-check-certificates",
    url,
  ];

  const { stdout, stderr, code } = await runYtDlp(args, { timeoutMs: 30_000 });

  if (code !== 0) {
    throw new Error(`yt-dlp info error: ${stderr.slice(0, 500)}`);
  }

  const data = JSON.parse(stdout);

  // Chỉ lấy danh sách quality video+audio đã mux sẵn hoặc dễ chọn,
  // để trả về cho client gọn gàng (tránh trả nguyên 100 format lẻ tẻ của yt-dlp).
  const formats = (data.formats || [])
    .filter((f) => f.vcodec && f.vcodec !== "none" && f.ext === "mp4")
    .map((f) => ({
      format_id: f.format_id,
      quality: f.format_note || f.height ? `${f.height}p` : f.format_note,
      height: f.height || null,
      fps: f.fps || null,
      filesize_mb: f.filesize ? Math.round((f.filesize / 1024 / 1024) * 10) / 10 : null,
      has_audio: f.acodec && f.acodec !== "none",
      ext: f.ext,
    }))
    .filter((f) => f.height)
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  // Loại trùng theo height, giữ bản có audio nếu có
  const seen = new Map();
  for (const f of formats) {
    const key = f.height;
    if (!seen.has(key) || (!seen.get(key).has_audio && f.has_audio)) {
      seen.set(key, f);
    }
  }

  return {
    id: data.id,
    title: data.title,
    duration_seconds: data.duration,
    thumbnail: data.thumbnail,
    uploader: data.uploader,
    upload_date: data.upload_date,
    available_qualities: Array.from(seen.values()),
  };
}

/**
 * Tải video theo quality được chọn (vd "720", "1080", "best", "worst").
 * Trả về đường dẫn file đã tải trên disk.
 */
export async function downloadVideo({ url, quality, outputTemplate }) {
  // Format selector: nếu user truyền số (chiều cao), build selector mux mp4
  // best video <= height + best audio, fallback "best" nếu không match.
  let formatSelector = "best[ext=mp4]/best";

  if (quality && quality !== "best" && quality !== "worst") {
    const height = parseInt(quality, 10);
    if (!Number.isNaN(height)) {
      formatSelector = `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${height}][ext=mp4]/best`;
    }
  } else if (quality === "worst") {
    formatSelector = "worst[ext=mp4]/worst";
  }

  const args = [
    "-f",
    formatSelector,
    "--merge-output-format",
    "mp4",
    "--no-playlist",
    "--no-warnings",
    "--no-check-certificates",
    "--max-filesize",
    `${CONFIG.MAX_FILE_SIZE_MB}M`,
    "-o",
    outputTemplate,
    "--print",
    "after_move:filepath",
    url,
  ];

  const { stdout, stderr, code } = await runYtDlp(args);

  if (code !== 0) {
    throw new Error(`yt-dlp download error: ${stderr.slice(0, 800)}`);
  }

  const filepath = stdout.trim().split("\n").filter(Boolean).pop();
  if (!filepath) {
    throw new Error("yt-dlp did not return an output filepath");
  }

  return filepath;
}
