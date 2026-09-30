const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;

// 跨域(与 Netlify 配置一致)
app.use(cors({
  origin: "*",
  allowedHeaders: ["Content-Type"],
  methods: ["POST", "OPTIONS", "GET"]
}));
app.use(express.json({ limit: "10kb" }));

// ---------- 配置 ----------
const CONFIG = {
  clientCode: "20260928",
  apiToken: "6d3bacb8-f628-48c2-8325-755802702a05",
  targetUrl: "http://182.254.162.146/api/track",
  types: ["waybillnumber", "systemnumber", "customernumber"],
  timeoutMs: 8000
};

// 两个 nextsls 查询接口(不同服务商, 依次尝试, 取第一个有数据/真实命中的)
const NEXT_SLS_APIS = [
  "https://tracking.nextsls.com/rest/trace/tracking/lists?app=656d92f573f0427e8e5ca536&number=",
  "https://tracking.nextsls.com/rest/trace/tracking/lists?app=67204e5c73f04246486924cb&number="
];

// OPTIONS 预检
app.options("/", (req, res) => res.sendStatus(200));
app.options("/nextsls", (req, res) => res.sendStatus(200));

// ---------- nextsls 中转: 依次尝试 2 个服务商接口, 返回第一个有数据的 ----------
app.post("/nextsls", async (req, res) => {
  try {
    const inputNo = (req.body.trackNo || "").trim().toUpperCase();
    console.log("nextsls 收到单号：", inputNo);
    if (!inputNo) return res.json({ status: 0, info: "运单号不能为空" });
    if (inputNo.length < 5 || inputNo.length > 18) return res.json({ status: 0, info: "单号长度需5-18位，请检查" });

    let last = null;
    for (const api of NEXT_SLS_APIS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
      try {
        const rawRes = await fetch(api + encodeURIComponent(inputNo), {
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
        });
        clearTimeout(timer);
        const json = await rawRes.json();
        last = json;
        // status===1 且有 shipment 才算有真实数据
        if (json && json.status === 1 && json.data && json.data.shipment) {
          const appId = api.split("app=")[1].split("&")[0];
          console.log(`nextsls 命中(${appId})：${inputNo}`);
          return res.json(json);
        }
      } catch (err) {
        clearTimeout(timer);
        last = { status: 0, info: "查询异常", error: err.message };
      }
    }
    console.log("两个 nextsls 均未命中，返回最后一次结果");
    return res.json(last);
  } catch (err) {
    console.error("nextsls 中转异常：", err);
    return res.json({ status: 0, info: "中转服务异常", error: err.message });
  }
});

// ---------- 核心 SCF 中转(原有, 复刻跑通的 serverless 逻辑) ----------
app.post("/", async (req, res) => {
  try {
    const inputNo = (req.body.trackNo || "").trim().toUpperCase();
    console.log("SCF 收到查询单号：", inputNo);

    if (!inputNo) return res.json({ code: -2, msg: "运单号不能为空" });
    if (inputNo.length < 5 || inputNo.length > 18) return res.json({ code: -2, msg: "单号长度需5-18位，请检查" });

    let lastResult = null;
    for (const type of CONFIG.types) {
      const postData = {
        authorization: { code: CONFIG.clientCode, token: CONFIG.apiToken },
        datas: { [type]: [inputNo] }
      };
      console.log(`SCF 尝试 ${type} 查询，报文：`, postData);

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
      console.log(`SCF ${type} 返回：`, result);
      lastResult = result;

      if (result.code === 0 && result.data && result.data.length > 0 && !result.data[0].errormsg) {
        console.log(`SCF ${type} 查询成功，返回结果`);
        return res.json(result);
      }
    }

    console.log("SCF 三种单号类型均查询失败，返回最后一次结果");
    return res.json(lastResult);
  } catch (err) {
    console.error("SCF 中转函数异常：", err);
    let msg = "中转服务异常";
    if (err.name === "AbortError") msg = "上游接口请求超时";
    return res.json({ code: -99, msg, error: err.message });
  }
});

// 健康检测 GET
app.get("/", (req, res) => {
  res.send("代理服务运行正常 | 渲染 Node Express");
});

// 拦截非 POST 请求
app.all("/", (req, res) => {
  return res.json({ code: -1, msg: "仅支持POST请求" });
});

app.listen(PORT, () => {
  console.log(`服务启动成功，端口:${PORT}`);
});
