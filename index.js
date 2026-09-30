const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({
  origin: "*",
  allowedHeaders: ["Content-Type"],
  methods: ["POST", "OPTIONS"]
}));
app.use(express.json({ limit: "10kb" }));

// 全局配置
const CONFIG = {
  api1Url: "https://tracking.nextsls.com/rest/trace/tracking/lists?app=656d92f573f0427e8e5ca536&number=",
  api2Url: "https://tracking.nextsls.com/rest/trace/tracking/lists?app=67204e5c73f04246486924cb&number=",
  fetchTimeout: 7000,
  api3: {
    clientCode: "20260928",
    apiToken: "6d3bacb8-f628-48c2-8325-755802702a05",
    targetUrl: "http://182.254.162.146/api/track",
    types: ["waybillnumber", "systemnumber", "customernumber"],
    timeoutMs: 8000
  }
};

app.options("/", (req, res) => {
  res.sendStatus(200);
});

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

    // 第一段 请求接口1
    let api1Result = null;
    try {
      const controller1 = new AbortController();
      const timer1 = setTimeout(() => controller1.abort(), CONFIG.fetchTimeout);
      const resp1 = await fetch(CONFIG.api1Url + encodeURIComponent(inputNo), {
        signal: controller1.signal
      });
      clearTimeout(timer1);
      if (resp1.ok) {
        const data1 = await resp1.json();
        if (data1.status === 1 && data1.data && data1.data.shipment) {
          api1Result = data1;
        }
      }
    } catch (err) {
      console.log("接口1请求异常：", err.message);
    }
    if (api1Result) {
      return res.json({
        code: 0,
        source: "api1",
        data: api1Result.data.shipment
      });
    }

    // 第二段 请求接口2
    let api2Result = null;
    try {
      const controller2 = new AbortController();
      const timer2 = setTimeout(() => controller2.abort(), CONFIG.fetchTimeout);
      const resp2 = await fetch(CONFIG.api2Url + encodeURIComponent(inputNo), {
        signal: controller2.signal
      });
      clearTimeout(timer2);
      if (resp2.ok) {
        const data2 = await resp2.json();
        if (data2.status === 1 && data2.data && data2.data.shipment) {
          api2Result = data2;
        }
      }
    } catch (err) {
      console.log("接口2请求异常：", err.message);
    }
    if (api2Result) {
      return res.json({
        code: 0,
        source: "api2",
        data: api2Result.data.shipment
      });
    }

    // 第三段 请求接口3
    console.log("接口1、2均无数据，执行接口3查询");
    let api3LastResult = null;
    const api3Config = CONFIG.api3;
    for (const type of api3Config.types) {
      const postData = {
        authorization: { code: api3Config.clientCode, token: api3Config.apiToken },
        datas: { [type]: [inputNo] }
      };
      console.log(`接口3 - 尝试 ${type} 查询，报文：`, postData);
      const controller3 = new AbortController();
      const timer3 = setTimeout(() => controller3.abort(), api3Config.timeoutMs);
      const rawRes3 = await fetch(api3Config.targetUrl, {
        method: "POST",
        signal: controller3.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postData)
      });
      clearTimeout(timer3);
      const result3 = await rawRes3.json();
      console.log(`接口3 - ${type} 返回：`, result3);
      api3LastResult = result3;
      if (result3.code === 0 && result3.data && result3.data.length > 0 && !result3.data[0].errormsg) {
        console.log(`接口3查询成功，返回结果`);
        return res.json({
          code: 0,
          source: "api3",
          data: result3.data
        });
      }
    }
    return res.json({
      code: 3,
      msg: "单号错误，请核对"
    });

  } catch (globalErr) {
    console.error("中转服务全局异常：", globalErr);
    let msg = "中转服务异常";
    if (globalErr.name === "AbortError") msg = "上游接口请求超时";
    return res.json({ code: -99, msg, error: globalErr.message });
  }
});

app.get("/", (req, res) => {
  res.send("代理服务运行正常 | 顺序查询1→2→3");
});

app.all("/", (req, res) => {
  return res.json({ code: -1, msg: "仅支持POST查询请求" });
});

app.listen(PORT, () => {
  console.log(`统一中转服务启动成功，监听端口：${PORT}`);
});
