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

  args.push("--extractor-args", "youtube:player_client=web,android,tv");

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

  // Lấy danh sách quality từ mọi format có video (không ép cứng ext=mp4),
  // vì Shorts/video một số trường hợp chỉ có sẵn webm ở các height cao.
  // File trả về cho client cuối cùng vẫn luôn là .mp4 (đã mux qua ffmpeg ở
  // bước download), nên không cần lo ext gốc khác mp4 ở bước info này.
  const formats = (data.formats || [])
    .filter((f) => f.vcodec && f.vcodec !== "none" && f.height)
    .map((f) => ({
      format_id: f.format_id,
      quality: `${f.height}p`,
      height: f.height || null,
      fps: f.fps || null,
      filesize_mb: f.filesize ? Math.round((f.filesize / 1024 / 1024) * 10) / 10 : null,
      has_audio: Boolean(f.acodec && f.acodec !== "none"),
      ext: f.ext,
    }))
    .sort((a, b) => (b.height || 0) - (a.height || 0));

  // Loại trùng theo height, giữ bản có audio nếu có, ưu tiên mp4 nếu cùng điều kiện
  const seen = new Map();
  for (const f of formats) {
    const key = f.height;
    const current = seen.get(key);
    if (!current) {
      seen.set(key, f);
      continue;
    }
    const fIsBetter =
      (f.has_audio && !current.has_audio) ||
      (f.has_audio === current.has_audio && f.ext === "mp4" && current.ext !== "mp4");
    if (fIsBetter) seen.set(key, f);
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

async function attemptDownload(url, formatSelector, sortOrder, outputTemplate) {
  const args = [
    "-f",
    formatSelector,
    ...(sortOrder ? ["-S", sortOrder] : []),
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

  return runYtDlp(args);
}

/**
 * Tải video theo quality được chọn (vd "720", "1080", "best", "worst").
 * Trả về đường dẫn file đã tải trên disk.
 */
export async function downloadVideo({ url, quality, outputTemplate }) {
  // Dùng kết hợp -f (giới hạn trần chất lượng) + -S (ưu tiên sắp xếp) thay vì
  // chỉ dùng -f filter cứng. Cách này khớp được cả 2 kiểu format YouTube trả về:
  // - Format tách rời video/audio (client web) -> cần cộng (+)
  // - Format đã muxed sẵn (client android/tv) -> không cần cộng, "+" sẽ không khớp
  let formatSelector = "bv*+ba/b";
  let sortOrder = null;

  if (quality && quality !== "best" && quality !== "worst") {
    const height = parseInt(quality, 10);
    if (!Number.isNaN(height)) {
      formatSelector = `bv*[height<=${height}]+ba/b[height<=${height}]/bv*+ba/b`;
      sortOrder = `res:${height}`;
    }
  } else if (quality === "worst") {
    formatSelector = "wv*+wa/w";
    sortOrder = "+res";
  }

  let { stdout, stderr, code } = await attemptDownload(
    url,
    formatSelector,
    sortOrder,
    outputTemplate
  );

  // Fallback: nếu format yêu cầu không khớp được gì, thử lại với "best" không
  // điều kiện kèm -S theo chất lượng mong muốn, vẫn ưu tiên đúng hướng nhưng
  // không loại trừ ứng viên nào tuyệt đối.
  if (code !== 0 && /[Rr]equested format is not available/.test(stderr)) {
    console.warn(
      `[ytdlp] format selector "${formatSelector}" failed, retrying with fallback "best"`
    );
    const retry = await attemptDownload(url, "best", sortOrder, outputTemplate);
    stdout = retry.stdout;
    stderr = retry.stderr;
    code = retry.code;
  }

  if (code !== 0) {
    throw new Error(`yt-dlp download error: ${stderr.slice(0, 1500)}`);
  }

  const filepath = stdout.trim().split("\n").filter(Boolean).pop();
  if (!filepath) {
    throw new Error("yt-dlp did not return an output filepath");
  }

  return filepath;
}
