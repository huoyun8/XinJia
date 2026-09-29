const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { AbortSignal } = require('timeout-signal');
const app = express();
const PORT = process.env.PORT || 10000;

// 全局跨域配置，兼容浏览器OPTIONS预检
app.use(cors({
  origin: "*",
  allowedHeaders: ["Content-Type"],
  methods: ["POST", "OPTIONS"]
}));
// 解析POST json body
app.use(express.json({ limit: "10kb" }));

// 固定上游鉴权配置，和你Netlify函数完全一致
const CONFIG = {
  clientCode: "20260928",
  apiToken: "6d3bacb8-f628-48c2-8325-755802702a05",
  upstreamUrl: "http://182.254.162.146/api/track",
  queryTypes: ["waybillnumber", "systemnumber", "customernumber"],
  timeoutMs: 8000
};

// 预检OPTIONS 单独处理
app.options("/trackProxy", (req, res) => {
  res.sendStatus(200);
});

// 核心中转接口
app.post("/trackProxy", async (req, res) => {
  try {
    const trackNo = (req.body.trackNo || "").trim();
    console.log("收到查询单号:", trackNo);

    // 单号校验逻辑不变
    if (!trackNo) {
      return res.json({ code: -2, msg: "运单号不能为空" });
    }
    if (trackNo.length < 5 || trackNo.length > 18) {
      return res.json({ code: -2, msg: "单号长度需5-18位，请检查" });
    }

    let lastUpstreamResp = null;
    // 循环三种单号类型轮询上游
    for (const type of CONFIG.queryTypes) {
      const payload = {
        authorization: {
          code: CONFIG.clientCode,
          token: CONFIG.apiToken
        },
        datas: {
          [type]: [trackNo]
        }
      };
      console.log(`【${type}】请求报文:`, payload);

      // 超时强制中断请求，卡死问题修复
      const signal = AbortSignal.timeout(CONFIG.timeoutMs);
      const fetchRes = await fetch(CONFIG.upstreamUrl, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const data = await fetchRes.json();
      console.log(`【${type}】上游返回:`, data);
      lastUpstreamResp = data;

      // 命中有效运单直接返回
      if (data.code === 0 && Array.isArray(data.data) && data.data.length > 0) {
        const firstItem = data.data[0];
        if (!firstItem.errormsg) {
          console.log(`【${type}】查询成功，直接返回数据`);
          return res.json(data);
        }
      }
    }

    // 三种类型全部无有效数据，返回最后一次上游响应
    console.log("全部类型查询无匹配运单，返回最后上游结果");
    return res.json(lastUpstreamResp);

  } catch (err) {
    console.error("中转全局捕获异常:", err.message, err.stack);
    // 区分超时/网络错误提示
    let errMsg = "中转服务异常";
    if (err.name === "AbortError") errMsg = "上游接口请求超时";
    return res.json({
      code: -99,
      msg: errMsg,
      errorDetail: err.message
    });
  }
});

// 拦截非POST非法请求
app.all("/trackProxy", (req, res) => {
  return res.json({ code: -1, msg: "仅支持 POST 请求" });
});

// Render健康检测必填路由
app.get("/", (req, res) => {
  res.send("Track Proxy Service Running OK | Render Node Express");
});

// 启动监听
app.listen(PORT, () => {
  console.log(`服务启动成功，端口:${PORT}`);
});
