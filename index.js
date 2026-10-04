// ============================================================
// xinjia.onrender.com 一体版入口
// 网页 + /track 中转接口（纯3号渠道，只查自己的单）
// 业务逻辑在 track-core.js，改核心只改 track-core.js 即可。
// ============================================================
const express = require("express");
const cors = require("cors");
const path = require("path");
const { queryTrack } = require("./track-core");
const app = express();
const PORT = process.env.PORT || 10000;
app.use(cors({ origin: "*", allowedHeaders: ["Content-Type"], methods: ["POST", "GET", "OPTIONS"] }));
app.use(express.json({ limit: "10kb" }));

// ★ 首页：index.html 放主目录，用 sendFile 只提供它，不暴露源码
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// ★ 中转接口：POST /track（保持小写，前端 PROXY_LIST 直指）
app.options("/track", (req, res) => res.sendStatus(200));
app.post("/track", async (req, res) => {
  const result = await queryTrack(req.body.trackNo || "");
  res.json(result);
});

app.listen(PORT, () => console.log(`服务启动成功，端口:${PORT}`));
