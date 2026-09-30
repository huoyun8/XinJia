/**
 * 全球物流查询平台 - Render 中转查询接口 (Node.js)
 *
 * 功能: 把外部请求转发到原系统查询接口
 *       GET http://120.79.98.64:7888/prod-api/order/track/html/getTrackByTrackNoNumberList
 *
 * 关键点:
 *  1. secretkey 由 AES-256-CBC 加密「上游端口号」生成, 密钥/IV 固化在前端 JS 中(已用 Node 验证一致)。
 *  2. 原接口需要登录态 session Cookie, 需在 Render 环境变量中配置 COOKIE。
 *
 * 环境变量:
 *  - ORIGIN_URL     上游系统地址, 默认 http://120.79.98.64:7888
 *  - UPSTREAM_PORT  上游端口(secretkey 明文), 默认 7888
 *  - COOKIE         上游登录态 Cookie(必填, 否则原接口返回 401)
 *  - PORT           Render 分配的端口, 默认 3000
 *
 * 对外接口:
 *  - GET  /api/track?numbers=单号1,单号2,...   (最多40个)
 *  - POST /api/track  body: {"numbers": ["单号1","单号2"]}
 *  - GET  /health    健康检查
 */
const crypto = require("crypto");
const express = require("express");

// ---------- 配置 ----------
const ORIGIN_URL = (process.env.ORIGIN_URL || "http://120.79.98.64:7888").replace(/\/$/, "");
const UPSTREAM_PORT = process.env.UPSTREAM_PORT || "7888";
const COOKIE = process.env.COOKIE || ""; // 上游登录态 Cookie
const PORT = process.env.PORT || 3000;

// ---------- 1. secretkey 生成 (AES-256-CBC + PKCS7, 与前端 JS 完全一致) ----------
const AES_KEY_B64 = "n8dO/MiByC/x+VwQScakZqpOiTm8t873oPOjEFJh/k4="; // 32 字节 -> AES-256
const AES_IV_B64 = "lXE7kVMGCrWRVEw2IMV7lA=="; // 16 字节

function encryptSecretkey(port) {
  const key = Buffer.from(AES_KEY_B64, "base64");
  const iv = Buffer.from(AES_IV_B64, "base64");
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  let enc = cipher.update(String(port), "utf8", "base64");
  enc += cipher.final("base64");
  return enc; // 例: RoipOXsuEHxtskZtnG7u1w==
}

// ---------- 2. 查询上游接口 ----------
const UPSTREAM_API = `${ORIGIN_URL}/prod-api/order/track/html/getTrackByTrackNoNumberList`;

async function queryUpstream(numbers) {
  if (!COOKIE) {
    return {
      ok: false,
      code: 401,
      msg: "中转服务未配置 COOKIE 环境变量(上游需登录态)",
    };
  }
  const params = new URLSearchParams({
    waybillStr: numbers.join(","),
    secretkey: encryptSecretkey(UPSTREAM_PORT),
  });
  const resp = await fetch(`${UPSTREAM_API}?${params.toString()}`, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: `${ORIGIN_URL}/#/track`,
      Accept: "application/json",
      Cookie: COOKIE,
    },
    signal: AbortSignal.timeout(30000),
  });
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, code: resp.status, msg: "上游返回非 JSON", raw: text.slice(0, 500) };
  }
  if (resp.status !== 200 || json.code !== 200) {
    return { ok: false, code: json.code || resp.status, msg: json.msg || "上游查询失败" };
  }
  return { ok: true, code: 200, msg: "操作成功", data: json.data };
}

// ---------- 3. Express 服务 ----------
const app = express();
app.use(express.json({ limit: "1mb" }));

function parseNumbers(input) {
  if (Array.isArray(input)) return input;
  if (typeof input === "string") return input.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", secretkey: encryptSecretkey(UPSTREAM_PORT) });
});

app.get("/api/track", async (req, res) => {
  const numbers = parseNumbers(req.query.numbers);
  if (!numbers.length) {
    return res.status(400).json({ code: 400, msg: "缺少参数 numbers(单号, 逗号分隔)", data: [] });
  }
  if (numbers.length > 40) {
    return res.status(400).json({ code: 400, msg: "最多支持40条数据进行操作!", data: [] });
  }
  const result = await queryUpstream(numbers);
  if (!result.ok) return res.status(result.code === 401 ? 401 : 502).json(result);
  const success = (result.data || []).filter((r) => r.code === 200);
  const fail = (result.data || []).filter((r) => r.code !== 200);
  return res.json({
    code: 200,
    msg: "操作成功",
    total: result.data.length,
    successCount: success.length,
    failCount: fail.length,
    data: result.data,
  });
});

app.post("/api/track", async (req, res) => {
  const numbers = parseNumbers(req.body && req.body.numbers);
  if (!numbers.length) {
    return res.status(400).json({ code: 400, msg: "缺少参数 numbers(单号数组)", data: [] });
  }
  if (numbers.length > 40) {
    return res.status(400).json({ code: 400, msg: "最多支持40条数据进行操作!", data: [] });
  }
  const result = await queryUpstream(numbers);
  if (!result.ok) return res.status(result.code === 401 ? 401 : 502).json(result);
  return res.json({
    code: 200,
    msg: "操作成功",
    total: result.data.length,
    successCount: (result.data || []).filter((r) => r.code === 200).length,
    failCount: (result.data || []).filter((r) => r.code !== 200).length,
    data: result.data,
  });
});

app.listen(PORT, () => {
  console.log(`Track proxy listening on port ${PORT}`);
  console.log(`Upstream: ${UPSTREAM_API} | secretkey=${encryptSecretkey(UPSTREAM_PORT)}`);
  console.log(`Cookie configured: ${COOKIE ? "yes" : "NO (上游将返回401)"}`);
});
