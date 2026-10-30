#!/usr/bin/env node
/**
 * 内嵌 KuGouMusicApi 零依赖 HTTP 壳服务（v2.1）
 *
 * 复刻 MakcRe/KuGouMusicApi server.js 行为 + MoeKoe Music 客户端的免登录播放机制：
 *   1. 稳定设备身份（uuid/dev/mac/mid/webgl）持久化，注入每个请求（KUGOU_API_MID 参与签名）
 *   2. register_dev 设备注册拿正式 dfid（best-effort）
 *   3. 强制上游直连（剥离代理环境变量），防止 VPN 全局模式劫持
 *   4. 上游 5xx 自动重试；Error 序列化为可读信息
 *   5. /__health 健康检查；空闲 30 分钟自动退出；pidfile 供升级时终止旧实例
 *
 * 启动：node kugou-server.cjs [--port=16100]
 */

const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

// 强制酷狗上游直连
delete process.env.HTTP_PROXY;
delete process.env.http_proxy;
delete process.env.HTTPS_PROXY;
delete process.env.https_proxy;
process.env.NO_PROXY = "*";

const VERSION = "2.1.5"; // 与 bin/music.mjs 的 PLUGIN_VERSION 保持一致
const PIDFILE = path.join(os.tmpdir(), "ruodao-music-player.pid");
const DEVFILE = path.join(os.tmpdir(), "ruodao-music-player.device.json");
const DFIDFILE = path.join(os.tmpdir(), "ruodao-music-player.dfid");
const IDLE_EXIT_MS = 30 * 60 * 1000;

const api = require(path.join(__dirname, "kugou-api.bundle.cjs"));

const USER_COOKIE = process.env.RUODAO_KUGOU_COOKIE || process.env.KUGOU_API_COOKIE || "";

// ---- 稳定设备身份（MoeKoe deviceUtil 同款）----
function loadOrCreateDevice() {
  try { return JSON.parse(fs.readFileSync(DEVFILE, "utf8")); } catch { /* 首次 */ }
  const u = api.__util || {};
  const uuid = u.getGuid ? u.getGuid() : require("node:crypto").randomUUID();
  const device = {
    dev: u.randomString ? u.randomString(10).toUpperCase() : "RDXA8K2M9Q",
    uuid,
    mac: "02:00:00:00:00:00",
    mid: u.calculateMid ? u.calculateMid(uuid) : require("node:crypto").createHash("md5").update(uuid).digest("hex"),
    webgl: u.generateWebGLHash ? String(u.generateWebGLHash()) : "9655615838832711846",
  };
  try { fs.writeFileSync(DEVFILE, JSON.stringify(device)); } catch { /* 忽略 */ }
  return device;
}
const DEVICE = loadOrCreateDevice();

// ---- 设备注册（best-effort）----
let registeredDfid = "";
let dfidPromise = null;
function ensureDfid() {
  if (registeredDfid) return Promise.resolve(registeredDfid);
  try {
    registeredDfid = fs.readFileSync(DFIDFILE, "utf8").trim();
    if (registeredDfid) return Promise.resolve(registeredDfid);
  } catch { /* 首次 */ }
  dfidPromise = dfidPromise || (async () => {
    try {
      // ⛔ register_dev 必须传 uuid/imei（取自稳定设备身份），否则上游返回异常数据导致解密失败
      const result = await callApi("register_dev", { uuid: DEVICE.uuid, imei: DEVICE.uuid, cookie: {} });
      const body = result?.body ?? result;
      const dfid = body?.data?.dfid || "";
      if (dfid) {
        registeredDfid = String(dfid);
        try { fs.writeFileSync(DFIDFILE, registeredDfid); } catch { /* 忽略 */ }
        console.log("[dfid] device registered:", String(registeredDfid).slice(0, 8) + "…");
      }
    } catch (e) {
      console.log("[dfid] register skipped:", String(e?.body?.error ?? e?.message ?? e).slice(0, 100));
    }
    return registeredDfid;
  })();
  return dfidPromise;
}

const argPort = (process.argv.find((a) => a.startsWith("--port=")) || "").split("=")[1];
const PORT = Number(argPort) || Number(process.env.KUGOU_SERVER_PORT) || 16100;

const routes = new Map();
for (const name of Object.keys(api)) {
  if (typeof api[name] !== "function") continue;
  routes.set(`/${name.replace(/_/g, "/")}`, name);
}

function send(res, status, body) {
  const text = JSON.stringify(body, (key, value) => {
    if (value instanceof Error) return value.message;
    return value;
  });
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
  });
  res.end(text);
}

async function callApi(name, params, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api[name](params);
    } catch (e) {
      const status = e?.status || 500;
      if (!(status >= 500 && attempt < retries)) throw e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
}

const server = http.createServer(async (req, res) => {
  resetIdle();
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "*",
    });
    return res.end();
  }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/__health") return send(res, 200, { version: VERSION, port: PORT, routes: routes.size, dfid: registeredDfid ? "registered" : "" });
  const name = routes.get(url.pathname);
  if (!name) return send(res, 404, { code: 404, data: null, msg: `Not Found: ${url.pathname}` });

  const params = {};
  for (const [k, v] of url.searchParams.entries()) params[k] = v;
  if (req.method === "POST") {
    let data = "";
    req.setEncoding("utf8");
    await new Promise((r) => { req.on("data", (c) => (data += c)); req.on("end", r); req.on("error", r); });
    try { Object.assign(params, JSON.parse(data || "{}")); } catch { params.data = data; }
  }

  try {
    if (!params.ip && !params.realIP) params.ip = "127.0.0.1";
    if (USER_COOKIE && !params.cookie) params.cookie = USER_COOKIE;
    // 稳定设备身份注入（KUGOU_API_MID 参与请求签名，缺失即被风控）
    const deviceCookie = {
      dev: DEVICE.dev,
      uuid: DEVICE.uuid,
      mac: DEVICE.mac,
      mid: DEVICE.mid,
      KUGOU_API_DEV: DEVICE.dev,
      KUGOU_API_GUID: DEVICE.uuid,
      KUGOU_API_MAC: DEVICE.mac,
      KUGOU_API_MID: DEVICE.mid,
      KUGOU_API_WEBGL: DEVICE.webgl,
    };
    if (typeof params.cookie === "string" && params.cookie) {
      params.cookie += ";" + Object.entries(deviceCookie).map(([k, v]) => `${k}=${v}`).join(";");
    } else {
      params.cookie = { ...(typeof params.cookie === "object" && params.cookie ? params.cookie : {}), ...deviceCookie };
    }
    if (name !== "register_dev") {
      const dfid = await ensureDfid();
      if (dfid) {
        if (typeof params.cookie === "object" && params.cookie) params.cookie.dfid = dfid;
        else params.cookie = (params.cookie || "") + `;dfid=${dfid}`;
      }
    }
    const result = await callApi(name, params);
    console.log("[OK]", decodeURIComponent(req.url));
    const body = result && typeof result === "object" && "body" in result ? result.body : result;
    send(res, (result && result.status) || 200, body ?? { status: 0, error_code: -1, error: "empty response" });
  } catch (e) {
    console.log("[ERR]", decodeURIComponent(req.url), e?.message || e);
    send(res, (e && e.status) || 502, (e && e.body) || { status: 0, error_code: -1, error: String(e?.message ?? e) });
  }
});

let idleTimer = null;
function resetIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.log("idle timeout, exiting");
    cleanupAndExit();
  }, IDLE_EXIT_MS);
  if (idleTimer.unref) idleTimer.unref();
}

function cleanupAndExit() {
  try { fs.rmSync(PIDFILE, { force: true }); } catch { /* 忽略 */ }
  process.exit(0);
}

process.on("SIGTERM", cleanupAndExit);
process.on("SIGINT", cleanupAndExit);
process.on("exit", () => { try { fs.rmSync(PIDFILE, { force: true }); } catch { /* 忽略 */ } });

server.listen(PORT, "127.0.0.1", () => {
  try { fs.writeFileSync(PIDFILE, JSON.stringify({ pid: process.pid, version: VERSION, port: PORT })); } catch { /* 忽略 */ }
  resetIdle();
  console.log(`embedded kugou server v${VERSION} running @ http://127.0.0.1:${PORT} (${routes.size} routes)`);
});
