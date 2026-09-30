const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;

// 跨域和Netlify配置完全一致
app.use(cors({
  origin: "*",
  allowedHeaders: ["Content-Type"],
  methods: ["POST", "OPTIONS"]
}));
app.use(express.json({ limit: "10kb" }));

const CONFIG = {
  clientCode: "20260928",
  apiToken: "6d3bacb8-f628-48c2-8325-755802702a05",
  targetUrl: "http://182.254.162.146/api/track",
  types: ["waybillnumber", "systemnumber", "customernumber"],
  timeoutMs: 8000
};

// OPTIONS预检
app.options("/", (req, res) => {
  res.sendStatus(200);
});

// 核心POST接口（逻辑完全复刻你跑通的serverless代码）
app.post("/", async (req, res) => {
  try {
    const inputNo = (req.body.trackNo || "").trim();
    console.log("收到查询单号：", inputNo);

    if (!inputNo) {
      return res.json({ code: -2, msg: "运单号不能为空" });
    }
    if (inputNo.length < 5 || inputNo.length > 18) {
      return res.json({ code: -2, msg: "单号长度需5-18位，请检查" });
    }

    let lastResult = null;
    for (const type of CONFIG.types) {
      const postData = {
        authorization: { code: CONFIG.clientCode, token: CONFIG.apiToken },
        datas: { [type]: [inputNo] }
      };
      console.log(`尝试 ${type} 查询，报文：`, postData);

      // 模拟Netlify timeout超时，原生AbortController，无第三方依赖
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
      const rawRes = await fetch(CONFIG.targetUrl, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postData)
      });
      clearTimeout(timer);
      const result = await rawRes.json();
      console.log(`${type} 返回：`, result);
      lastResult = result;

      if (result.code === 0 && result.data && result.data.length > 0 && !result.data[0].errormsg) {
        console.log(`${type} 查询成功，返回结果`);
        return res.json(result);
      }
    }

    console.log("三种单号类型均查询失败，返回最后一次结果");
    return res.json(lastResult);
  } catch (err) {
    console.error("中转函数异常：", err);
    let msg = "中转服务异常";
    if (err.name === "AbortError") msg = "上游接口请求超时";
    return res.json({ code: -99, msg, error: err.message });
  }
});

// 健康检测GET
app.get("/", (req, res) => {
  res.send("代理服务运行正常 | 渲染 Node Express");
});

// 拦截非POST请求
app.all("/", (req, res) => {
  return res.json({ code: -1, msg: "仅支持POST请求" });
});

app.listen(PORT, () => {
  console.log(`服务启动成功，端口:${PORT}`);
});
