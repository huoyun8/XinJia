// secretkey 生成 —— AES-256-CBC + PKCS7，与前端 JS 逐字节一致（已用 Node 实测 = RoipOXsuEHxtskZtnG7u1w==）
const crypto = require("crypto");
function encryptSecretkey(port) {
  const key = Buffer.from("n8dO/MiByC/x+VwQScakZqpOiTm8t873oPOjEFJh/k4=", "base64");
  const iv  = Buffer.from("lXE7kVMGCrWRVEw2IMV7lA==", "base64");
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  let enc = cipher.update(String(port), "utf8", "base64");
  return enc + cipher.final("base64");
}

// 转发上游
const UPSTREAM_API = `${ORIGIN_URL}/prod-api/order/track/html/getTrackByTrackNoNumberList`;
async function queryUpstream(numbers) {
  const params = new URLSearchParams({ waybillStr: numbers.join(","), secretkey: encryptSecretkey(UPSTREAM_PORT) });
  const resp = await fetch(`${UPSTREAM_API}?${params}`, { headers: { "User-Agent": "...", Referer: `${ORIGIN_URL}/#/track`, Cookie: COOKIE } });
  const json = await resp.json();
  if (resp.status !== 200 || json.code !== 200) return { ok: false, code: json.code, msg: json.msg };
  return { ok: true, code: 200, data: json.data };
}
