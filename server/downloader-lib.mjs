// Pure helpers for the Facebook link downloader, kept separate so they can be unit tested.

const HOSTS = new Set(['facebook.com', 'fb.watch']);

/**
 * Validate a pasted link. Returns { url, key } where `key` is a stable id used to spot repeat links,
 * or { error } with a plain message. Only public Facebook video/reel links are accepted, so the
 * server can never be pointed at an arbitrary address.
 */
export function parseFacebookUrl(input) {
  let u;
  try {
    u = new URL(String(input ?? '').trim());
  } catch {
    return { error: 'That does not look like a link.' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'That does not look like a link.' };
  const host = u.hostname.toLowerCase().replace(/^(www|m|web|mbasic|mobile|l)\./, '');
  if (!HOSTS.has(host)) return { error: 'Only Facebook links are supported (facebook.com or fb.watch).' };
  u.protocol = 'https:';
  u.hostname = host === 'fb.watch' ? 'fb.watch' : 'www.facebook.com';
  u.hash = '';
  const path = u.pathname.replace(/\/+$/, '');
  let key;
  let m;
  if ((m = /^\/reel\/(\d+)$/.exec(path))) key = `fb:${m[1]}`;
  else if ((m = /^\/(?:[^/]+\/)?videos\/(?:[^/]+\/)?(\d+)$/.exec(path))) key = `fb:${m[1]}`;
  else if (path === '/watch' && /^\d+$/.test(u.searchParams.get('v') ?? '')) key = `fb:${u.searchParams.get('v')}`;
  else if (host === 'fb.watch' || path.startsWith('/share/')) key = `url:${u.hostname}${path}`;
  else return { error: 'This does not look like a Facebook video or reel link.' };
  // Tracking parameters are not part of the video's identity and only make links look different.
  if (key.startsWith('fb:') && path !== '/watch') u.search = '';
  return { url: u.toString(), key };
}

/** Pull every http(s) link out of free text (one per line, space separated, or pasted in a message). */
export function extractUrls(text) {
  return [...new Set(String(text ?? '').match(/https?:\/\/[^\s<>"']+/gi) ?? [])];
}

/**
 * Turn yt-dlp's stderr into a message a person can act on.
 * Facebook's login wall frequently surfaces as a vague parse error, so that is treated as "blocked".
 */
export function friendlyError(stderr, exitCode) {
  const s = String(stderr ?? '');
  if (/ENOENT|not found|spawn/i.test(s) && /yt-dlp/i.test(s)) {
    return 'The downloader is not installed on the server.';
  }
  if (/getaddrinfo|network is unreachable|timed out|connection (reset|refused)|name resolution|Tunnel connection|ProxyError|urlopen error/i.test(s)) {
    return 'The server could not reach Facebook. Check its internet connection.';
  }
  if (/private|friends only|only visible|content isn't available|not available|removed|deleted|no longer available/i.test(s)) {
    return 'This reel is private or unavailable. Only public reels can be downloaded. Try uploading it instead.';
  }
  if (/log ?in|cookies|authentication|checkpoint|cannot parse data|unable to extract|unsupported url|Unable to download webpage/i.test(s)) {
    return 'Facebook blocked this link (public reels only, and it sometimes blocks even those). Try uploading the video instead.';
  }
  if (/429|too many requests|rate.?limit/i.test(s)) {
    return 'Facebook is rate limiting the server. Wait a while and try again.';
  }
  if (/ffmpeg/i.test(s)) return 'The server could not merge the video (ffmpeg problem).';
  if (/yt-dlp: error|ERROR/i.test(s)) {
    return 'Download failed. Facebook may have changed something; try "Update downloader", or upload the video instead.';
  }
  return `Download failed (exit ${exitCode ?? '?'}). Try "Update downloader", or upload the video instead.`;
}

/** A readable file name from the video title, falling back to the id. */
export function titleToName(title, id) {
  const clean = String(title ?? '')
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${clean || `facebook-${id}`}.mp4`;
}

/** Parse a yt-dlp `--progress-template` line like `dl:42.3%`. Returns a 0..1 fraction or undefined. */
export function parseProgress(line) {
  const m = /^dl:\s*([\d.]+)%/.exec(line.trim());
  return m ? Math.min(1, Number(m[1]) / 100) : undefined;
}
