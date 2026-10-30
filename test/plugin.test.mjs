import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "music.mjs");
const pluginVersion = readFileSync(bin, "utf8").match(/PLUGIN_VERSION\s*=\s*"([^"]+)"/)?.[1] || "";

const requests = [];
let stub = null;

const rankSongs = [
  {
    songname: "<em>夜曲</em>",
    author_name: "周杰伦",
    album_audio_id: 111,
    album_id: 222,
    audio_info: { hash_128: "h128", hash_320: "h320", hash_flac: "hflac", duration_320: 226000 },
    album_info: { album_name: "十一月的萧邦", sizable_cover: "https://img.example/cover/{size}.jpg" },
    privilege_download: { privilege: 10, privilege_128: 10 },
    trans_param: { hash_offset: { start_ms: 0, end_ms: 60000 } },
  },
  {
    songname: "晴天",
    author_name: "周杰伦",
    audio_info: { hash_128: "h128b", duration_128: 269500 },
    privilege_download: { privilege: 8, privilege_128: 8 },
    trans_param: { union_cover: "https://img.example/union.jpg", free_limited: 1 },
  },
];

function route(url) {
  const u = new URL(url, "http://stub");
  const q = Object.fromEntries(u.searchParams);
  if (u.pathname === "/__health") return { ok: true, version: pluginVersion };
  if (u.pathname === "/rank/info") {
    if (q.rankid === "9999") {
      return {
        data: {
          rankname: "回退榜单",
          rank_cid: 7,
          songinfo: [{ songname: "回退曲目", author_name: "回退歌手", hash: "fallback-hash" }],
        },
      };
    }
    return {
      data: {
        rankname: "测试榜单",
        imgurl: "https://img.example/rank/{size}.jpg",
        intro: "榜单介绍",
        rank_cid: 42,
        play_times: 123456,
        songinfo: rankSongs.slice(0, 3).map((s) => ({ songname: s.songname, author_name: s.author_name })),
      },
    };
  }
  if (u.pathname === "/rank/audio") {
    if (q.rankid === "9999") return { data: { total: 1, songlist: [] } };
    return { data: { total: 120, songlist: rankSongs } };
  }
  if (u.pathname === "/rank/list") {
    return {
      data: {
        info: [{
          rankid: 8888,
          rankname: "<em>测试榜单</em>",
          imgurl: "https://img.example/rank/{size}.jpg",
          play_times: 230000000,
          songinfo: [{ songname: "A" }, { songname: "B" }, { songname: "C" }, { songname: "D" }],
        }],
      },
    };
  }
  if (u.pathname === "/song/url") {
    if (q.hash === "vip-hash") {
      return q.free_part === "1"
        ? { data: { url: ["https://cdn.example/trial.mp3"], timeLength: 60, hash_offset: { start_ms: 0, end_ms: 30000 } } }
        : { data: { url: [] } };
    }
    return { data: { url: [`https://cdn.example/${q.hash}.mp3`], timeLength: 245 } };
  }
  if (u.pathname === "/search/hot") return { list: [{ keywords: [{ keyword: "测试热搜" }] }] };
  if (u.pathname === "/search") {
    return {
      data: {
        lists: [
          { FileHash: "search-free", SongName: "免费曲目", SingerName: "搜索歌手", Duration: 200, Privilege: 8, trans_param: { free_limited: 1 } },
          { FileHash: "search-vip", SongName: "VIP 曲目", SingerName: "搜索歌手", Duration: 210, Privilege: 10, trans_param: { hash_offset: { start_ms: 61200, end_ms: 121200 } } },
        ],
      },
    };
  }
  if (u.pathname === "/top/song") return { data: { songlist: [{ hash: "top-hash", songname: "新歌", author_name: "新歌手" }] } };
  return { data: {} };
}

/** 异步 spawn：stub 服务器与用例同进程，同步 spawnSync 会阻塞事件循环导致死锁 */
function run(mode, stdin = "") {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, mode], {
      env: {
        ...process.env,
        RUODAO_MUSIC_EMBED_PORT: String(stub.port),
        RUODAO_MUSIC_API_BASE: "http://127.0.0.1:1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 60000);
    child.on("close", () => {
      clearTimeout(timer);
      let out;
      try { out = JSON.parse(stdout.trim().split("\n").pop()); }
      catch { out = { state: "unparseable", stdout, stderr }; }
      resolve({ ...out, raw: stdout });
    });
    child.stdin.end(stdin);
  });
}

test.before(async () => {
  stub = createServer((req, res) => {
    requests.push({ path: req.url, at: Date.now() });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(route(req.url)));
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  stub.port = stub.address().port;
});

test.after(() => {
  stub?.close();
});

test("未知模式返回 failed 且带提示", async () => {
  const out = await run("nope");
  assert.equal(out.state, "failed");
  assert.match(out.error, /未知模式/);
  assert.match(out.error, /play/);
});

test("search 缺少关键词返回 failed", async () => {
  const out = await run("search");
  assert.equal(out.state, "failed");
  assert.match(out.error, /关键词/);
});

test("play 无 hash 无 keywords 返回 failed", async () => {
  const out = await run("play");
  assert.equal(out.state, "failed");
  assert.match(out.error, /hash/);
});

test("lyric 无 hash 无 keywords 返回 failed", async () => {
  const out = await run("lyric");
  assert.equal(out.state, "failed");
});

test("playlist 缺少 id 返回 failed", async () => {
  const out = await run("playlist");
  assert.equal(out.state, "failed");
  assert.match(out.error, /歌单 id/);
});

test("榜单详情走 /rank/audio 并映射多音质 hash / 封面 / 毫秒时长", async () => {
  const out = await run("rank", JSON.stringify({ rankid: 8888 }));
  assert.equal(out.state, "succeeded");
  assert.equal(out.source, "rank/audio");
  assert.equal(out.total, 120);
  assert.equal(out.page, 1);
  assert.equal(out.pagesize, 100);
  assert.equal(out.hasMore, true);
  assert.equal(out.rank.rankCid, 42);
  assert.equal(out.rank.name, "测试榜单");
  assert.equal(out.rank.playCount, 123456);
  assert.equal(out.songs.length, 2);

  const first = out.songs[0];
  assert.equal(first.name, "夜曲");
  assert.equal(first.singer, "周杰伦");
  assert.equal(first.hash, "h320");
  assert.equal(first.hashes["128"], "h128");
  assert.equal(first.hashes.flac, "hflac");
  assert.equal(first.albumAudioId, 111);
  assert.equal(first.albumId, 222);
  assert.equal(first.albumName, "十一月的萧邦");
  assert.equal(first.cover, "https://img.example/cover/{size}.jpg");
  assert.equal(first.duration, "3:46");
  assert.equal(first.durationSec, 226);
  assert.equal(first.access, "vip");
  assert.equal(first.trialSec, 60);

  assert.equal(out.songs[1].cover, "https://img.example/union.jpg");
  assert.equal(out.songs[1].duration, "4:30");
  assert.equal(out.songs[1].access, "free");
  assert.equal(out.songs[1].trialSec, undefined);

  const audioReq = requests.map((r) => r.path).find((p) => p.startsWith("/rank/audio?rankid=8888"));
  assert.ok(audioReq, "应请求 /rank/audio");
  assert.match(audioReq, /rank_cid=42/);
  assert.match(audioReq, /page=1/);
  assert.match(audioReq, /pagesize=100/);
});

test("/rank/audio 为空时回退 /rank/info 摘要", async () => {
  const out = await run("rank", JSON.stringify({ rankid: 9999 }));
  assert.equal(out.state, "succeeded");
  assert.equal(out.source, "rank/info");
  assert.equal(out.songs.length, 1);
  assert.equal(out.songs[0].name, "回退曲目");
  assert.equal(out.songs[0].hash, "fallback-hash");
  assert.equal(out.rank.name, "回退榜单");
  assert.equal(out.rank.rankCid, 7);
});

test("榜单列表映射播放量与前三首预览", async () => {
  const out = await run("rank");
  assert.equal(out.state, "succeeded");
  assert.equal(out.ranks.length, 1);
  const rank = out.ranks[0];
  assert.equal(rank.id, 8888);
  assert.equal(rank.name, "测试榜单");
  assert.equal(rank.playCount, 230000000);
  assert.deepEqual(rank.preview, ["A", "B", "C"]);
});

test("play 按音质选择对应 hash", async () => {
  const out = await run("play", JSON.stringify({
    hash: "h320",
    hashes: { "128": "h128", "320": "h320" },
    name: "夜曲",
    singer: "周杰伦",
    quality: "320",
  }));
  assert.equal(out.state, "succeeded");
  assert.equal(out.url, "https://cdn.example/h320.mp3");
  assert.equal(out.quality, "320");
  assert.equal(out.isTrial, false);
  assert.equal(out.song.singer, "周杰伦");
  const urlReq = requests.map((r) => r.path).find((p) => p.startsWith("/song/url") && p.includes("hash=h320"));
  assert.ok(urlReq, "应按 320 音质 hash 请求播放地址");
  assert.match(urlReq, /ppage_id=356753938/);
});

test("play 无完整地址时降级 60 秒试听并标记 isTrial", async () => {
  const out = await run("play", JSON.stringify({ hash: "vip-hash", name: "VIP歌", singer: "VIP歌手", quality: "128" }));
  assert.equal(out.state, "succeeded");
  assert.equal(out.url, "https://cdn.example/trial.mp3");
  assert.equal(out.quality, "128");
  assert.equal(out.isTrial, true);
  assert.equal(out.trialSec, 30);
  const trialReq = requests.map((r) => r.path).find((p) => p.includes("vip-hash") && p.includes("free_part=1"));
  assert.ok(trialReq, "应带 free_part=1 请求试听地址");
});

test("search 映射免费 / VIP 试听权限", async () => {
  const out = await run("search", JSON.stringify({ keywords: "测试" }));
  assert.equal(out.state, "succeeded");
  assert.equal(out.songs.length, 2);
  assert.equal(out.songs[0].access, "free");
  assert.equal(out.songs[0].trialSec, undefined);
  assert.equal(out.songs[1].access, "vip");
  assert.equal(out.songs[1].trialSec, 60);
});

test("输出始终是单行 JSON（state 字段）", async () => {
  for (const mode of ["doctor", "hot", "search", "play", "rank", "top"]) {
    const out = await run(mode, mode === "search" ? '{"keywords":"x"}' : "");
    assert.ok(out && typeof out === "object" && "state" in out, `${mode} 应输出含 state 的 JSON`);
    assert.equal(String(out.raw).trim().split("\n").length, 1, `${mode} 的 stdout 必须是单行 JSON`);
  }
});
