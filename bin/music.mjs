#!/usr/bin/env node
/**
 * Ruodao 音乐播放插件（v2.0，MoeKoe Music 方案）
 *
 * 架构（最简化）：所有酷狗能力直接调用本机 MoeKoe Music 客户端内置的
 * KuGouMusicApi 服务（默认 http://127.0.0.1:6521）。
 *
 * 为什么选 MoeKoe：
 *   - MoeKoe Music 客户端启动时已完成设备注册与风控处理，匿名即可取播放地址
 *   - codex-harness-desktop（github.com/PMZPZM0/codex-harness-desktop）即采用此方案
 *   - 插件自身零第三方依赖，不再内嵌/维护任何服务
 *
 * 前置：安装并运行 MoeKoe Music（music.moekoe.cn）。未安装时可用 moekoe_install 一键安装。
 *
 * 配置：
 *   RUODAO_MUSIC_API_BASE   MoeKoe 本地 API 地址，默认 http://127.0.0.1:6521
 *   RUODAO_MUSIC_QUALITY    音质：128 / 320 / flac / hi，默认 320
 *   RUODAO_MUSIC_PAGESIZE   搜索每页条数，默认 20
 *   MOEKOE_EXE              MoeKoe 客户端 exe 路径（可选，用于自动拉起）
 *
 * 命令：doctor / hot / search / play / lyric / rank / playlist / top / moekoe_install / moekoe_status
 * 输出：stdout 单行 JSON（state: succeeded | failed）
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, } from "node:url";
import { readFile } from "node:fs/promises";

const PLUGIN_VERSION = "2.1.5"; // 与 vendor/kugou-server.cjs 的 VERSION 保持一致
const PIDFILE = path.join(os.tmpdir(), "ruodao-music-player.pid");
const EMBEDDED_PORT = () => Number(env("RUODAO_MUSIC_EMBED_PORT", "16100")) || 16100;
const VENDOR_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor");
const KUGOU_API_BASE = () => `http://127.0.0.1:${EMBEDDED_PORT()}`;

/** fetch + 手动超时：不能用 AbortSignal.timeout（Windows 下触发 libuv 断言崩溃 UV_HANDLE_CLOSING） */
async function fetchT(url, opts = {}, ms = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error(`timeout ${ms}ms`)), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

const env = (k, d = "") => (process.env[k] ?? d).trim();

const API_BASE = () => env("RUODAO_MUSIC_API_BASE", "http://127.0.0.1:6521").replace(/\/+$/, "");
const QUALITY = () => env("RUODAO_MUSIC_QUALITY", "320");
const PAGESIZE = () => Number(env("RUODAO_MUSIC_PAGESIZE", "20")) || 20;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + "\n");
}
function fail(message, extra = {}) {
  emit({ state: "failed", error: message, ...extra });
  process.exit(1);
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve({});
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => {
      try { resolve(data.trim() ? JSON.parse(data) : {}); }
      catch { resolve({ prompt: data.trim() }); }
    });
    process.stdin.on("error", () => resolve({}));
  });
}

/* ---------------- MoeKoe 本地 API 客户端 ---------------- */

let cachedDfid = "";

async function probe() {
  try {
    const res = await fetchT(`${API_BASE()}/register/dev`, { headers: { accept: "application/json", "user-agent": UA } }, 2500);
    if (!res.ok) return { reachable: false, dfid: "" };
    const dfid = String((await res.json())?.data?.dfid ?? "").trim();
    if (dfid) cachedDfid = dfid;
    return { reachable: true, dfid };
  } catch { return { reachable: false, dfid: "" }; }
}

async function ensureApi() {
  let p = await probe();
  if (p.dfid) return p;
  // 已安装未运行：自动拉起客户端并等待就绪
  const exe = findMoeKoeExe();
  if (exe) {
    spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      p = await probe();
      if (p.reachable) return p;
    }
  }
  return p;
}

/* ---------------- 内嵌 KuGouMusicApi 服务（主通道，免登录播放） ----------------
 * 与 MoeKoe Music 客户端同款机制内置进插件：稳定设备身份 + register_dev 注册 dfid。
 * 服务不可达时自动后台拉起（vendor/kugou-server.cjs，工作目录在临时目录避免锁安装目录）。
 * 失败时自动降级到 MoeKoe 客户端本地 API（6521）。
 */
let serverReady = null;

async function embeddedReachable(base, timeoutMs = 2500) {
  try {
    const r = await fetchT(`${base}/__health`, {}, timeoutMs);
    return r.ok || (r.status >= 400 && r.status < 500);
  } catch { return false; }
}

async function serverVersion(base) {
  try {
    const r = await fetchT(`${base}/__health`, {}, 2500);
    if (r.ok) return (await r.json())?.version || "";
  } catch { /* 旧版无 __health */ }
  return "";
}

async function killStaleServer(base) {
  let pid = 0;
  try {
    const info = JSON.parse(await readFile(PIDFILE, "utf8"));
    if (info?.pid) pid = Number(info.pid);
  } catch { /* 无 pidfile */ }
  if (!pid) return false;
  try { process.kill(pid); } catch { /* 已退出 */ }
  for (let i = 0; i < 15; i++) {
    if (!(await embeddedReachable(base, 800))) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function ensureEmbedded() {
  const base = KUGOU_API_BASE();
  if (await embeddedReachable(base)) {
    const v = await serverVersion(base);
    if (!v || v === PLUGIN_VERSION) return base;
    await killStaleServer(base);
  }
  const serverScript = path.join(VENDOR_DIR, "kugou-server.cjs");
  try {
    // 工作目录用临时目录：Windows 会锁定进程 cwd，避免插件重装 EBUSY
    spawn(process.execPath, [serverScript, `--port=${EMBEDDED_PORT()}`], {
      cwd: os.tmpdir(), detached: true, windowsHide: true, stdio: "ignore",
    }).unref();
  } catch { /* 忽略 */ }
  for (let i = 0; i < 20; i++) {
    if (await embeddedReachable(base, 1200)) return base;
    await new Promise((r) => setTimeout(r, 500));
  }
  return "";
}

async function api(pathname, params = {}, { dfid = true } = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const full = `${pathname}${qs.size ? `?${qs}` : ""}`;
  const errors = [];

  // 主通道：内嵌 KuGouMusicApi 服务（免登录播放：设备身份 + dfid 注册）
  const embeddedBase = await ensureEmbedded();
  if (embeddedBase) {
    try {
      const res = await fetchT(`${embeddedBase}${full}`, { headers: { accept: "application/json", "user-agent": UA } }, 25000);
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { throw new Error(`非 JSON（HTTP ${res.status}）：${text.slice(0, 150)}`); }
      if (res.status < 400) return body;
      errors.push(`内嵌服务 HTTP ${res.status}`);
    } catch (e) {
      errors.push(`内嵌服务：${String(e?.message ?? e).slice(0, 120)}`);
    }
  }

  // 兜底通道：MoeKoe Music 客户端本地 API（6521）
  const headers = { accept: "application/json", "user-agent": UA };
  const d = dfid ? (cachedDfid || (await probe()).dfid) : "";
  if (d) headers.Authorization = `dfid=${d}`;
  let res;
  try {
    res = await fetchT(`${API_BASE()}${full}`, { headers }, 20000);
  } catch (e) {
    if (errors.length) throw new Error(`${errors.join("；")}；MoeKoe Music 也未就绪（${API_BASE()}）：${e.message}。可在插件界面点击「一键安装 MoeKoe Music」`);
    throw new Error(`无法连接 MoeKoe Music 本地服务（${API_BASE()}）：${e.message}。请确认 MoeKoe Music 已安装并正在运行，或点击「一键安装 MoeKoe Music」。`);
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`MoeKoe API 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`); }
  if (res.status >= 400) throw new Error(`接口 ${pathname} 返回 HTTP ${res.status}：${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

/* ---------------- 字段兼容提取 ---------------- */

function pick(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return "";
}

function stripEm(s) {
  return String(s ?? "").replace(/<\/?em>/g, "");
}

function fmtDuration(sec) {
  let n = Number(sec) || 0;
  if (n > 10000) n = Math.round(n / 1000); // 毫秒转秒
  const m = Math.floor(n / 60), s = n % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function durationSecOf(row, audio) {
  const raw = pick(audio, "duration_320", "duration_128", "duration_flac", "duration_high", "duration_super")
    || pick(row, "timelength", "Duration", "duration");
  const n = Number(raw) || 0;
  if (!n) return 0;
  return Math.round(n > 10000 ? n / 1000 : n); // 榜单接口给毫秒，搜索接口给秒
}

/**
 * 会员权限：privilege_128 = 8 表示标准音质免费完整播放，10 表示 VIP。
 * 榜单在 privilege_download、搜索在顶层 Privilege、新歌在 privilege_128。
 */
function accessOf(row, trans) {
  const privDownload = row.privilege_download && typeof row.privilege_download === "object" ? row.privilege_download : {};
  let raw = pick(privDownload, "privilege_128", "privilege");
  if (raw === "") raw = pick(row, "Privilege", "privilege_128", "privilege");
  const privilege = Number(raw);
  if (privilege !== 8 && privilege !== 10) return {};
  const offset = (trans.hash_offset && typeof trans.hash_offset === "object" ? trans.hash_offset : null)
    || (row.hash_offset && typeof row.hash_offset === "object" ? row.hash_offset : null)
    || {};
  const spanMs = Math.max(0, (Number(offset.end_ms) || 0) - (Number(offset.start_ms) || 0));
  return {
    access: privilege === 8 ? "free" : "vip",
    trialSec: privilege === 10 && spanMs > 0 ? Math.max(1, Math.round(spanMs / 1000)) : undefined,
  };
}

function mapSong(row) {
  if (!row || typeof row !== "object") return row;
  const audio = row.audio_info && typeof row.audio_info === "object" ? row.audio_info : {};
  const album = row.album_info && typeof row.album_info === "object" ? row.album_info : {};
  const trans = row.trans_param && typeof row.trans_param === "object" ? row.trans_param : {};
  let name = stripEm(pick(row, "songname", "SongName", "filename", "FileName", "name", "fileName", "ori_song_name", "songName"));
  let singer = stripEm(pick(row, "singername", "SingerName", "author_name", "author", "singers", "singer"));
  if (!singer && name.includes(" - ")) {
    const [a, ...rest] = name.split(" - ");
    if (rest.length) { singer = a.trim(); name = rest.join(" - ").trim(); }
  }
  const hashes = {};
  for (const [quality, key] of [["128", "hash_128"], ["320", "hash_320"], ["flac", "hash_flac"], ["high", "hash_high"], ["super", "hash_super"]]) {
    if (audio[key]) hashes[quality] = String(audio[key]);
  }
  const hash = pick(row, "hash", "Hash", "FileHash", "filehash")
    || hashes["320"] || hashes["128"] || hashes.flac || hashes.high || hashes.super;
  const coverRaw = pick(row, "cover", "sizable_cover", "img", "Image", "album_sizable_cover", "album_cover")
    || pick(trans, "union_cover")
    || pick(album, "sizable_cover")
    || pick(row, "imgurl");
  const durationSec = durationSecOf(row, audio);
  return {
    name,
    singer,
    hash,
    hashes: Object.keys(hashes).length ? hashes : undefined,
    albumAudioId: pick(row, "album_audio_id", "AlbumAudioID", "MixSongID", "audio_id", "Audioid", "audioid"),
    albumId: pick(row, "album_id", "AlbumID"),
    albumName: stripEm(pick(album, "album_name") || pick(row, "album_name", "AlbumName", "remark")),
    duration: fmtDuration(durationSec),
    durationSec: durationSec || undefined,
    cover: typeof coverRaw === "string" ? coverRaw : undefined,
    ...accessOf(row, trans),
  };
}

function extractSongList(data) {
  const roots = [data, data?.data];
  for (const root of roots) {
    if (Array.isArray(root)) return root.map(mapSong).filter((s) => s.hash || s.name);
  }
  // 兼容 search(data.lists) / top(data[]) / rank/audio(data.songlist) / rank/info(data.songinfo)
  for (const root of roots) {
    if (!root || typeof root !== "object") continue;
    for (const key of ["songlist", "lists", "list", "songs", "songinfo", "musics", "tracks"]) {
      if (Array.isArray(root[key])) return root[key].map(mapSong).filter((s) => s.hash || s.name);
    }
  }
  return [];
}

/* ---------------- MoeKoe 客户端安装/拉起 ---------------- */

function findMoeKoeExe() {
  const explicit = env("MOEKOE_EXE");
  if (explicit) return explicit;
  const bases = new Set();
  for (const v of [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]]) {
    if (v) bases.add(v);
  }
  // 1) 常见固定路径
  const candidates = [];
  for (const base of bases) {
    candidates.push(path.join(base, "MoeKoe Music", "MoeKoe Music.exe"));
    candidates.push(path.join(base, "Programs", "MoeKoe Music", "MoeKoe Music.exe"));
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* 忽略 */ }
  }
  // 2) 模糊扫描：安装目录名/exe 名可能带版本号或不同命名（MoeKoe*/moe-koe* 等）
  for (const base of bases) {
    const progDirs = [base, path.join(base, "Programs")];
    for (const progDir of progDirs) {
      try {
        for (const dir of fs.readdirSync(progDir)) {
          if (!/moe.{0,3}koe/i.test(dir)) continue;
          if (/updater|installer|cache|crash/i.test(dir)) continue; // 排除更新器/安装包缓存目录
          const dirFull = path.join(progDir, dir);
          try {
            const exes = fs.readdirSync(dirFull).filter((f) => /\.exe$/i.test(f) && !/unins|crash/i.test(f));
            const preferred = exes.find((f) => /music/i.test(f)) || (exes.length === 1 ? exes[0] : "");
            if (preferred) return path.join(dirFull, preferred);
          } catch { /* 忽略 */ }
        }
      } catch { /* 目录不存在 */ }
    }
  }
  return "";
}

/* ---------------- 命令实现 ---------------- */

async function doctor() {
  const embeddedBase = await ensureEmbedded();
  const embeddedVersion = await serverVersion(embeddedBase || KUGOU_API_BASE());
  const p = await probe();
  const exe = findMoeKoeExe();
  emit({
    state: "succeeded",
    apiBase: API_BASE(),
    embeddedBase: KUGOU_API_BASE(),
    quality: QUALITY(),
    checks: {
      embedded: {
        ok: Boolean(embeddedBase),
        version: embeddedVersion || "(未运行)",
        hint: embeddedBase ? "内嵌 KuGouMusicApi 服务连通（免登录播放通道）" : "内嵌服务未能启动，将尝试 MoeKoe 兜底",
      },
      moekoe: {
        ok: Boolean(p.reachable && p.dfid),
        installed: Boolean(exe),
        running: p.reachable,
        deviceRegistered: Boolean(p.dfid),
        exe: exe || "",
        hint: p.dfid ? "MoeKoe Music 播放通道就绪（备用）" : "MoeKoe Music 未运行（备用通道，可选）",
      },
    },
    ok: Boolean(embeddedBase || (p.reachable && p.dfid)),
  });
}

async function hot() {
  const data = await api("/search/hot", { navid: 1, plat: 2 });
  const groups = data?.list || data?.tabs || data?.data?.list || [];
  const list = (Array.isArray(groups) ? groups : []).flatMap((g) =>
    (g?.keywords || g?.list || []).map((h) => ({
      keyword: pick(h, "keyword", "word", "kw", "name"),
      reason: pick(h, "reason") || undefined,
    }))
  ).filter((x) => x.keyword);
  emit({ state: "succeeded", total: list.length, hot: list, hint: "把 keyword 交给 search 命令即可搜索" });
}

async function search(input) {
  const keywords = input.keywords || input.keyword || input.prompt || "";
  if (!keywords) fail("缺少搜索关键词：请传入 { keywords } 或在界面输入内容");
  const data = await api("/search", { keywords, page: input.page || 1, pagesize: input.pagesize || PAGESIZE(), type: "song" });
  const songs = extractSongList(data);
  if (!songs.length) fail(`未搜索到与「${keywords}」相关的歌曲`, { keywords });
  emit({ state: "succeeded", keywords, songs, hint: "点击歌曲即可播放；hash 可用于 play / lyric 命令" });
}

async function play(input) {
  const quality = String(input.quality || QUALITY());
  let hash = input.hash || "";
  let meta = input;

  // 只给了关键词：先搜索（MoeKoe 搜索结果自带 hash）
  if (!hash && (input.keywords || input.prompt || (input.name && input.singer))) {
    const keywords = input.keywords || input.prompt || [input.singer, input.name].filter(Boolean).join(" ");
    const data = await api("/search", { keywords, page: 1, pagesize: 20, type: "song" });
    const songs = extractSongList(data);
    if (!songs.length) fail(`未搜索到与「${keywords}」相关的歌曲`);
    meta = songs[Math.max(0, (Number(input.index) || 1) - 1)];
    hash = meta.hash || "";
    if (!hash && input.name) {
      const hit = songs.find((s) => stripEm(s.name).includes(stripEm(input.name).slice(0, 4)));
      if (hit) { meta = hit; hash = hit.hash; }
    }
  }
  if (!hash) fail("缺少 hash：请传 { hash } 或 { keywords } 让插件自动搜索");

  // 榜单歌曲一条记录带多个音质 hash（audio_info.hash_128/hash_320/...），按请求音质选对应 hash
  const hashMap = {
    ...(meta && meta.hashes && typeof meta.hashes === "object" ? meta.hashes : {}),
    ...(input.hashes && typeof input.hashes === "object" ? input.hashes : {}),
  };
  const hashForQuality = (q) => {
    if (q === "hi") return hashMap.high || hashMap.flac || hash;
    if (q === "flac") return hashMap.flac || hashMap.high || hash;
    return hashMap[String(q)] || hash;
  };
  const albumAudioId = input.album_audio_id || meta?.albumAudioId || "";
  const albumId = input.album_id || meta?.albumId || "";

  // ⛔ ppage_id 是 MoeKoe 客户端同款参数：缺了它，付费歌会被判风控/只给 60 秒试听
  // 音质自动降级：请求的音质取不到完整 URL 时回落到 128（免费歌 128 通常可完整播放）
  const qChain = [...new Set([quality === "flac" || quality === "hi" ? "flac" : quality, "320", "128"])];
  let data = null;
  let usedQuality = qChain[0];
  let isTrial = false;
  let url = "";
  let root = null;
  const fetchUrlFor = async (q, extra = {}) => {
    const d = await api("/song/url", {
      hash: hashForQuality(q),
      quality: q,
      ppage_id: "356753938",
      album_audio_id: albumAudioId,
      album_id: albumId,
      ...extra,
    });
    const r0 = d && typeof d === "object" ? (Array.isArray(d.data) ? d.data[0] : d.data ?? d) : {};
    const u0 = [].concat(r0?.url ?? [], r0?.backupUrl ?? []).find((u) => typeof u === "string" && /^https?:\/\//i.test(u)) || "";
    return { d, r0, u0 };
  };
  // 第一轮：请求音质逐档尝试完整播放
  for (const q of qChain) {
    const { d, r0, u0 } = await fetchUrlFor(q);
    data = d;
    if (u0) { usedQuality = q; data = d; url = u0; root = r0; break; }
    // 无 hash_offset（非试听）且无 url → 该音质不可用，尝试下一档
  }
  // 第二轮：VIP 歌拿不到完整版时，降级为 60 秒试听（free_part=1），不直接报错
  if (!url && (data?.hash_offset || true)) {
    for (const q of [...new Set(["128", quality === "flac" || quality === "hi" ? "flac" : quality])]) {
      const { d, r0, u0 } = await fetchUrlFor(q, { free_part: 1 });
      if (u0) { data = d; url = u0; root = r0; usedQuality = q; isTrial = true; break; }
    }
  }
  root = root || (data && typeof data === "object" ? (Array.isArray(data.data) ? data.data[0] : data.data ?? data) : {});
  const urls = [].concat(root?.url ?? [], root?.backupUrl ?? []);
  if (!url) url = urls.find((u) => typeof u === "string" && /^https?:\/\//i.test(u)) || "";
  const trialOffset = root?.hash_offset && typeof root.hash_offset === "object" ? root.hash_offset : {};
  const trialSpanMs = Math.max(0, (Number(trialOffset.end_ms) || 0) - (Number(trialOffset.start_ms) || 0));
  const trialSec = isTrial && trialSpanMs > 0 ? Math.max(1, Math.round(trialSpanMs / 1000)) : undefined;
  emit({
    state: "succeeded",
    song: mapSong(meta),
    quality: usedQuality,
    isTrial,
    trialSec,
    url,
    urls,
    source: "embedded",
    timeLength: pick(root || {}, "timeLength", "timelength"),
    error: url ? undefined : (pick(root || {}, "error", "msg") || "未取得播放地址"),
    hint: url
      ? "将 url 交给任意播放器播放"
      : /验证|20028/.test(String(pick(root || {}, "error", "msg")))
        ? "酷狗要求安全验证：请在 MoeKoe Music 客户端里搜索/播放一次完成验证后再试"
        : "未取得播放地址：该歌曲可能需要 VIP（MoeKoe 登录后可解锁）或无版权",
  });
}

async function lyric(input) {
  const keywords = input.keywords || input.prompt || "";
  let hash = input.hash || "";
  let duration = Number(input.duration) || 0;
  if (!hash && keywords) {
    const data = await api("/search", { keywords, page: 1, pagesize: 1, type: "song" });
    const songs = extractSongList(data);
    if (!songs.length) fail(`未搜索到与「${keywords}」相关的歌曲`);
    hash = songs[0].hash;
    duration = duration || Number(songs[0].durationSec) || 0;
  }
  if (!hash) fail("缺少 hash 或 keywords");

  const cand = await api("/search/lyric", { hash, duration, keywords });
  const candidate = cand?.candidates?.[0];
  if (!candidate) fail("未找到对应歌词");
  const dl = await api("/lyric", { id: candidate.id, accesskey: candidate.accesskey, fmt: "lrc", decode: 1 });
  const content = dl?.decodeContent || (dl?.content ? Buffer.from(dl.content, "base64").toString("utf8") : "");
  emit({ state: "succeeded", hash, lyricsFormat: "lrc", lyrics: content });
}

async function rank(input) {
  const rankid = input.rankid || input.id || "";
  if (rankid) {
    const page = Math.max(1, Number(input.page) || 1);
    const pagesize = Math.min(100, Math.max(1, Number(input.pagesize) || 100));
    // /rank/info 只带前 3 首摘要且没有 hash；完整歌曲必须走 /rank/audio（rank_cid + 分页）
    let info = {};
    try {
      const infoBody = await api("/rank/info", { rankid });
      info = infoBody?.data && typeof infoBody.data === "object" ? infoBody.data : (infoBody || {});
    } catch { /* 个别榜单没有 info，继续走 audio */ }
    const rankCid = input.rank_cid || info.rank_cid || 0;
    let songs = [];
    let total = 0;
    let source = "rank/audio";
    try {
      const audio = await api("/rank/audio", { rankid, rank_cid: rankCid, page, pagesize });
      songs = extractSongList(audio);
      total = Number(audio?.data?.total ?? audio?.total) || songs.length;
    } catch { /* 回退到 info 摘要 */ }
    if (!songs.length) {
      songs = extractSongList(info);
      total = Math.max(total, songs.length);
      source = "rank/info";
    }
    const rank = {
      id: rankid,
      name: stripEm(pick(info, "rankname", "name", "title")) || input.name || "",
      cover: pick(info, "imgurl", "img", "cover"),
      intro: pick(info, "intro"),
      rankCid,
      playCount: Number(pick(info, "play_times", "playcount")) || undefined,
    };
    emit({
      state: "succeeded",
      rankid,
      rank,
      page,
      pagesize,
      total,
      hasMore: total > page * pagesize,
      source,
      songs,
      hint: songs.length ? "点击歌曲即可播放；传 page 可继续加载下一页" : "该榜单暂无歌曲，可稍后重试或换一个榜单",
    });
    return;
  }
  const data = await api("/rank/list", { plat: 2, withsong: 1, parentid: 0 });
  // 响应结构：{ data: { info: [榜单...] } }（部分版本直接在顶层 info）
  const lists = (data?.data?.info || data?.info || data?.list || data?.lists || []).map((r) => ({
    id: pick(r, "rankid", "id", "classid"),
    name: stripEm(pick(r, "rankname", "name", "title")),
    cover: pick(r, "imgurl", "img", "cover"),
    updateTime: pick(r, "updatetime", "update_time") || undefined,
    playCount: Number(pick(r, "play_times", "playcount", "playTimes")) || undefined,
    preview: (Array.isArray(r?.songinfo) ? r.songinfo : []).slice(0, 3)
      .map((s) => stripEm(pick(s, "songname", "name", "filename")))
      .filter(Boolean),
  })).filter((r) => r.id && r.name);
  emit({ state: "succeeded", ranks: lists, hint: "传入 { rankid } 可查看某个榜单的完整歌曲列表" });
}

async function playlist(input) {
  const id = input.id || input.global_collection_id || "";
  if (!id) fail("缺少歌单 id：请传 { id }（歌单 global_collection_id）");
  const tracks = await api("/playlist/track/all", { id, global_collection_id: id, page: input.page || 1, pagesize: input.pagesize || PAGESIZE() });
  const songs = extractSongList(tracks);
  const d = tracks?.list_info ?? {};
  emit({
    state: "succeeded",
    id,
    name: pick(d, "name", "title", "specialname") || input.name || "",
    count: Number(pick(tracks, "count")) || songs.length,
    songs,
    hint: "点击歌曲即可播放",
  });
}

async function top(input) {
  const typeMap = { 1: 21608, 2: 13228, 3: 22650, 4: 22651 };
  const type = Number(input.type) || 1;
  const rankId = Number(input.rankid) || typeMap[type] || 21608;
  const data = await api("/top/song", { rank_id: rankId, page: input.page || 1, pagesize: input.pagesize || PAGESIZE() });
  const songs = extractSongList(data);
  if (!songs.length) fail("未获取到新歌速递数据");
  emit({ state: "succeeded", type, rankId, songs, hint: "点击歌曲即可播放" });
}

/* ---------------- MoeKoe 一键安装（后台执行 + 进度文件轮询） ---------------- */

const INSTALL_STATE_FILE = path.join(os.tmpdir(), "ruodao-music-player-install.json");

function writeInstallState(step, message, percent) {
  try {
    fs.writeFileSync(INSTALL_STATE_FILE, JSON.stringify({ step, message, percent: Math.round(percent ?? 0), at: Date.now() }));
  } catch { /* 忽略 */ }
}

async function moekoeInstall() {
  const exe = findMoeKoeExe();
  if (exe) {
    // 已安装：直接启动并等待就绪
    writeInstallState("launch", "MoeKoe Music 已安装，正在启动…", 90);
    spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
    await waitMoeKoeReady();
    emit({ state: "succeeded", installed: true, started: true, hint: "MoeKoe Music 播放通道就绪" });
    return;
  }
  // 后台启动安装 worker（本脚本自身），立即返回；UI 轮询 moekoe_progress 看实时进度
  try { fs.rmSync(INSTALL_STATE_FILE, { force: true }); } catch { /* 清除上次残留状态 */ }
  spawn(process.execPath, [fileURLToPath(import.meta.url), "__moekoe_install_worker"], {
    detached: true, windowsHide: true, stdio: "ignore",
  }).unref();
  emit({ state: "succeeded", installed: false, started: true, step: "download", percent: 0, hint: "安装已在后台开始：下载官方安装包 → 静默安装 → 自动启动，进度请在界面上查看" });
}

/**
 * 稳健下载（v2）：
 *   1) 先探测各候选源延迟，选最快的源
 *   2) 8 线程分段并行下载（Range 请求），单线程被限速也能跑满带宽
 *   3) 某个分段失败自动用其他源重试该分段
 *   4) 完成后按官方大小校验
 */
const GH_MIRRORS = [
  "", // GitHub 直连优先
  "https://ghfast.top/",
  "https://gh-proxy.com/",
  "https://ghproxy.net/",
  "https://moeyy.cn/github-proxy/",
];
const SEGMENT_PARALLEL = 24; // 多线程分段：直连被限速时靠并发数拉满带宽

async function fetchWithRetry(url, headers, timeoutMs = 30000) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetchT(url, { headers, redirect: "follow" }, timeoutMs);
      if (res.ok) return res;
      if (res.status >= 500) { await new Promise((r) => setTimeout(r, 1000)); continue; }
      return res; // 4xx 直接返回由调用方处理
    } catch (e) {
      if (i === 2) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function downloadResilient(asset, onProgress, onNote = () => {}) {
  const expected = Number(asset.size) || 0;
  const file = asset.browser_download_url;
  const candidates = GH_MIRRORS.map((m) => m ? m + file : file);

  // 1) 源探测：1KB Range 请求测可用性（保持候选顺序：直连优先，镜像兜底）
  onNote("正在检测可用的下载源…");
  const usable = [];
  for (const url of candidates) {
    try {
      const res = await fetchT(url, { headers: { "user-agent": UA, Range: "bytes=0-1023" }, redirect: "follow" }, 8000);
      await res.arrayBuffer();
      if (res.ok) usable.push({ url, partial: res.status === 206 });
      if (usable.length >= 3) break;
    } catch { /* 源不可用，跳过 */ }
  }
  if (!usable.length) throw new Error("所有下载源均不可达。建议：关闭 VPN/代理后重试，或到 music.moekoe.cn 手动下载安装");
  onNote(`已就绪 ${usable.length} 个下载源（直连优先）`);

  // 2) 分段并行下载
  if (!expected) {
    // 未知大小：退化为单线程整包下载
    const res = await fetchWithRetry(usable[0].url, { "user-agent": UA });
    return Buffer.from(await res.arrayBuffer());
  }
  const segCount = SEGMENT_PARALLEL;
  const segSize = Math.ceil(expected / segCount);
  const segs = new Array(segCount);
  let doneBytes = 0;
  let lastPct = -1;
  const report = () => {
    const pct = doneBytes / expected;
    if (Math.floor(pct * 100) !== lastPct) {
      lastPct = Math.floor(pct * 100);
      onProgress(doneBytes, expected);
    }
  };
  const downloadSeg = async (idx) => {
    let start = idx * segSize;
    let end = Math.min((idx + 1) * segSize, expected) - 1;
    if (start > end) { segs[idx] = Buffer.alloc(0); return; }
    for (let attempt = 0; attempt < 8; attempt++) {
      // 分段轮流分布到所有可用源（探测延迟最短的源拿更多分段）
      const rank = idx + attempt;
      const src = usable[rank % usable.length];
      try {
        const res = await fetchWithRetry(src.url, { "user-agent": UA, Range: `bytes=${start}-${end}` }, 60000);
        if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const want = end - start + 1;
        if (buf.length !== want) throw new Error(`分段字节数不符（${buf.length}/${want}）`);
        segs[idx] = buf;
        doneBytes += buf.length;
        report();
        return;
      } catch (e) {
        // 分段失败：换源重试该分段
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error(`分段 ${idx} 下载失败（已换源重试 8 次）`);
  };
  await Promise.all(Array.from({ length: segCount }, (_, i) => downloadSeg(i)));
  const buf = Buffer.concat(segs);
  if (expected && Math.abs(buf.length - expected) / expected > 0.02) {
    throw new Error(`下载校验失败（应为 ${(expected / 1024 / 1024).toFixed(0)}MB，实际 ${(buf.length / 1024 / 1024).toFixed(0)}MB）`);
  }
  return buf;
}

/** 安装 worker：下载 → 静默安装 → 启动 → 等待设备注册，全程写进度文件 */
async function moekoeInstallWorker() {
  try {
    if (findMoeKoeExe()) { await finishInstall(); return; }
    writeInstallState("download", "正在获取 MoeKoe Music 官方安装包信息…", 2);
    const rel = await (await fetchT("https://api.github.com/repos/iAJue/MoeKoeMusic/releases/latest", { headers: { "user-agent": UA } }, 30000)).json();
    const assets = (rel?.assets ?? []).filter((a) => /\.exe$/i.test(a?.name ?? "") && !/blockmap/i.test(a?.name ?? ""));
    const asset = assets.find((a) => /x64/i.test(a.name)) || assets[0];
    if (!asset) { writeInstallState("failed", "未在官方 release 找到 Windows 安装包，请到 music.moekoe.cn 手动下载安装", 0); return; }
    const tmpInstaller = path.join(os.tmpdir(), asset.name);
    writeInstallState("download", `正在下载 ${asset.name}（约 ${(Number(asset.size) / 1024 / 1024).toFixed(0)}MB）…`, 5);
    let lastPercent = 5;
    const buf = await downloadResilient(
      asset,
      (received, total) => {
        lastPercent = 5 + (received / total) * 60;
        writeInstallState("download", `正在下载安装包… ${(received / 1024 / 1024).toFixed(1)}/${(total / 1024 / 1024).toFixed(1)}MB`, lastPercent);
      },
      (note) => writeInstallState("download", note, lastPercent),
    );
    // downloadResilient 内部已按官方 asset.size 校验字节数
    fs.writeFileSync(tmpInstaller, buf);
    writeInstallState("install", `下载完成（${(buf.length / 1024 / 1024).toFixed(1)}MB），正在静默安装（约 1-2 分钟）…`, 70);
    await new Promise((resolve) => {
      const child = spawn(tmpInstaller, ["/S"], { windowsHide: true, stdio: "ignore" });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } resolve(); }, 300000);
      child.on("exit", () => { clearTimeout(timer); resolve(); });
      child.on("error", () => { clearTimeout(timer); resolve(); });
    });
    // 静默安装后等文件系统落盘（持续写心跳，避免进度文件因超时被判定过期）
    for (let i = 0; i < 15; i++) {
      if (findMoeKoeExe()) break;
      writeInstallState("install", "正在静默安装，请稍候…", 70);
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!findMoeKoeExe()) {
      // 静默安装失败（可能需要 UAC 授权）：通过 start 强制前台弹出图形向导，后台持续检测
      writeInstallState("install", "静默安装未完成，正在打开图形安装向导——请在弹出的窗口中点击「下一步/安装」完成安装；如果任务栏有闪烁图标请点开它。我会自动检测安装结果…", 75);
      try {
        spawn("cmd.exe", ["/c", "start", "", tmpInstaller], { detached: true, windowsHide: false, stdio: "ignore" }).unref();
      } catch { /* 忽略 */ }
      for (let i = 0; i < 300; i++) {
        if (findMoeKoeExe()) break;
        writeInstallState("install", "正在等待图形安装向导完成——请在弹出的窗口中点击「下一步/安装」（我会自动检测安装结果）", 75);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    await finishInstall();
  } catch (e) {
    writeInstallState("failed", String(e?.message ?? e), 0);
  }
}

async function finishInstall() {
  const installedExe = findMoeKoeExe();
  if (!installedExe) {
    writeInstallState("failed", "安装程序已运行但未检测到 MoeKoe Music：请手动完成安装后重试点播；或到 music.moekoe.cn 手动下载安装", 0);
    return;
  }
  writeInstallState("launch", "安装完成，正在启动 MoeKoe Music…", 85);
  // 启动 + 双重重试（客户端首次启动可能较慢）
  for (let attempt = 0; attempt < 3; attempt++) {
    spawn(installedExe, [], { detached: true, stdio: "ignore" }).unref();
    let p = { reachable: false, dfid: "" };
    for (let i = 0; i < 30; i++) {
      p = await probe();
      if (p.dfid) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (p.dfid) {
      writeInstallState("ready", "MoeKoe Music 播放通道就绪，现在可以点播歌曲了！", 100);
      return;
    }
  }
  writeInstallState("partial", "MoeKoe 已安装并启动，但设备注册未完成；请在 MoeKoe 客户端窗口里搜索/播放一次后再试点播", 95);
}

async function moekoeProgress() {
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(INSTALL_STATE_FILE, "utf8"));
    // 超过 15 分钟的旧状态视为过期，避免残留的 failed 一直显示
    if (state?.at && Date.now() - state.at > 15 * 60 * 1000) state = null;
  } catch { state = null; }
  const p = await probe();
  if (p.dfid) state = { step: "ready", message: "MoeKoe Music 播放通道就绪，现在可以点播歌曲了！", percent: 100 };
  emit({
    state: "succeeded",
    installed: Boolean(findMoeKoeExe()),
    running: p.reachable,
    dfid: Boolean(p.dfid),
    step: state?.step ?? (findMoeKoeExe() ? "ready" : "none"),
    message: state?.message ?? "",
    percent: state?.percent ?? 0,
  });
}

async function waitMoeKoeReady() {
  for (let i = 0; i < 30; i++) {
    const p = await probe();
    if (p.dfid) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function moekoeStatus() {
  const p = await probe();
  const exe = findMoeKoeExe();
  emit({ state: "succeeded", installed: Boolean(exe), running: p.reachable, dfid: Boolean(p.dfid), exe: exe || "", api: API_BASE() });
}

/* ---------------- main ---------------- */

const stdin = await readStdin();
// 工作台 UI 会把用户保存的配置通过 stdin JSON 的 config 字段传进来
if (stdin.config && typeof stdin.config === "object") {
  for (const [key, value] of Object.entries(stdin.config)) {
    if (/^RUODAO_[A-Z0-9_]+$/.test(key) && value != null && String(value).trim()) process.env[key] = String(value).trim();
  }
}
const mode = process.argv[2] ?? "";
try {
  if (mode === "doctor") await doctor();
  else if (mode === "hot") await hot();
  else if (mode === "search") await search(stdin);
  else if (mode === "play") await play(stdin);
  else if (mode === "lyric") await lyric(stdin);
  else if (mode === "rank") await rank(stdin);
  else if (mode === "playlist") await playlist(stdin);
  else if (mode === "top") await top(stdin);
  else if (mode === "moekoe_install") await moekoeInstall();
  else if (mode === "__moekoe_install_worker") await moekoeInstallWorker();
  else if (mode === "moekoe_progress") await moekoeProgress();
  else if (mode === "moekoe_status") await moekoeStatus();
  else fail(`未知模式：${mode}（支持 doctor / hot / search / play / lyric / rank / playlist / top / moekoe_install / moekoe_progress / moekoe_status）`);
} catch (e) {
  const msg = String(e?.message ?? e);
  const needsMoeKoe = /无法连接 MoeKoe/.test(msg);
  fail(msg, { needsMoeKoe, hint: needsMoeKoe ? "在插件界面点击「一键安装 MoeKoe Music」即可自动下载安装并解锁播放" : undefined });
}
