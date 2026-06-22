import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { CONFIG } from "../config.js";

// Cache đường dẫn cookies writable đã copy, để không phải copy lại mỗi request
let writableCookiesPath = null;

/**
 * Render Secret Files được mount read-only ở /etc/secrets/.
 * yt-dlp có thể cố ghi lại cookies đã refresh vào chính file --cookies khi
 * đóng tiến trình (save_cookies), và sẽ crash nếu file đó read-only.
 * Giải pháp: copy cookies sang một file writable trong /tmp trước, dùng file đó.
 */
function getWritableCookiesPath() {
  if (!CONFIG.COOKIES_PATH) return null;

  if (writableCookiesPath && fs.existsSync(writableCookiesPath)) {
    return writableCookiesPath;
  }

  try {
    if (!fs.existsSync(CONFIG.COOKIES_PATH)) return null;
    const dest = path.join(os.tmpdir(), "yt-cookies-writable.txt");
    fs.copyFileSync(CONFIG.COOKIES_PATH, dest);
    fs.chmodSync(dest, 0o600);
    writableCookiesPath = dest;
    console.log(`[ytdlp] copied cookies to writable path: ${dest}`);
    return dest;
  } catch (err) {
    console.error(`[ytdlp] failed to copy cookies to writable path: ${err.message}`);
    return null;
  }
}

/**
 * Chạy yt-dlp với danh sách arguments, trả về { stdout, stderr, code }
 * Không dùng exec/shell string để tránh injection - dùng spawn với array args.
 */
function runYtDlp(args, { timeoutMs = CONFIG.DOWNLOAD_TIMEOUT_MS } = {}) {
  console.log(`[ytdlp] spawning: ${CONFIG.YTDLP_PATH} ${args.join(" ")}`);

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
      console.error(`[ytdlp] spawn error: ${err.message}`);
      reject(err);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        console.error("[ytdlp] process timed out and was killed");
        return reject(new Error("yt-dlp timed out"));
      }
      console.log(`[ytdlp] exited with code=${code}`);
      if (code !== 0) {
        console.error(`[ytdlp] stderr:\n${stderr}`);
      }
      resolve({ stdout, stderr, code });
    });
  });
}

/**
 * Trả về các flag chung áp dụng cho mọi lệnh yt-dlp:
 * - Cookies (nếu có cấu hình COOKIES_PATH) để né lỗi "Sign in to confirm you're not a bot".
 * - Giả lập player client "android" - thường ít bị yêu cầu xác minh bot hơn client web,
 *   và không cần PO token như client web/tv hiện tại.
 */
function buildAntiBotArgs() {
  const args = [];

  if (CONFIG.COOKIES_PATH) {
    const writablePath = getWritableCookiesPath();
    console.log(
      `[ytdlp] COOKIES_PATH="${CONFIG.COOKIES_PATH}" resolved writable path="${writablePath}"`
    );
    if (writablePath) {
      args.push("--cookies", writablePath);
    } else {
      console.warn(
        `[ytdlp] WARNING: COOKIES_PATH is set but file could not be prepared. ` +
          `Cookies will NOT be used for this request.`
      );
    }
  } else {
    console.log("[ytdlp] COOKIES_PATH is not set - running without cookies.");
  }

  args.push("--extractor-args", "youtube:player_client=android,web");

  return args;
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
    ...buildAntiBotArgs(),
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
  // Format selector: nhiều tầng fallback, không ép cứng ext ở từng bước
  // (chỉ ép mp4 ở output cuối qua --merge-output-format, ffmpeg tự convert khi cần).
  // Điều này quan trọng với Shorts / video có ít format khả dụng, dễ bị
  // "Requested format is not available" nếu ép ext quá sớm.
  let formatSelector = "bestvideo+bestaudio/best";

  if (quality && quality !== "best" && quality !== "worst") {
    const height = parseInt(quality, 10);
    if (!Number.isNaN(height)) {
      formatSelector =
        `bestvideo[height<=${height}]+bestaudio/` +
        `best[height<=${height}]/` +
        `bestvideo+bestaudio/best`;
    }
  } else if (quality === "worst") {
    formatSelector = "worstvideo+worstaudio/worst";
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
    ...buildAntiBotArgs(),
    "-o",
    outputTemplate,
    "--print",
    "after_move:filepath",
    url,
  ];

  const { stdout, stderr, code } = await runYtDlp(args);

  if (code !== 0) {
    throw new Error(`yt-dlp download error: ${stderr.slice(0, 1500)}`);
  }

  const filepath = stdout.trim().split("\n").filter(Boolean).pop();
  if (!filepath) {
    throw new Error("yt-dlp did not return an output filepath");
  }

  return filepath;
}
