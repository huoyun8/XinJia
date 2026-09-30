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

// 统一查询入口
app.post("/", async (req, res) => {
  try {
    const inputNo = (req.body.trackNo || "").trim();
    console.log("收到查询单号：", inputNo);

    // 单号基础校验
    if (!inputNo) {
      return res.json({ code: -2, msg: "运单号不能为空" });
    }
    if (inputNo.length < 5 || inputNo.length > 18) {
      return res.json({ code: -2, msg: "单号长度需5-18位，请检查" });
    }

    // ====================== 第一步：查询接口1 ======================
    let api1ValidData = null;
    try {
      const abortCtrl = new AbortController();
      const timer = setTimeout(() => abortCtrl.abort(), CONFIG.fetchTimeout);
      const resp = await fetch(CONFIG.api1Url + encodeURIComponent(inputNo), {
        signal: abortCtrl.signal
      });
      clearTimeout(timer);

      // http状态异常直接抛出，进入catch丢弃
      if (!resp.ok) throw new Error(`HTTP状态码${resp.status}`);
      const jsonData = await resp.json();

      // 校验是否存在有效物流数据
      if (jsonData.status === 1 && jsonData.data && Array.isArray(jsonData.data.shipment) && jsonData.data.shipment.length > 0) {
        api1ValidData = jsonData.data.shipment;
      }
    } catch (err) {
      // 接口1任意错误：超时/4xx/5xx/json解析失败，直接丢弃，打印日志继续下一个
      console.log(`【接口1】查询失败，丢弃，错误信息：${err.message}`);
    }

    // 接口1拿到有效数据，直接返回，终止流程
    if (api1ValidData) {
      return res.json({
        code: 0,
        source: "api1",
        data: api1ValidData
      });
    }

    // ====================== 第二步：查询接口2 ======================
    let api2ValidData = null;
    try {
      const abortCtrl = new AbortController();
      const timer = setTimeout(() => abortCtrl.abort(), CONFIG.fetchTimeout);
      const resp = await fetch(CONFIG.api2Url + encodeURIComponent(inputNo), {
        signal: abortCtrl.signal
      });
      clearTimeout(timer);

      if (!resp.ok) throw new Error(`HTTP状态码${resp.status}`);
      const jsonData = await resp.json();

      if (jsonData.status === 1 && jsonData.data && Array.isArray(jsonData.data.shipment) && jsonData.data.shipment.length > 0) {
        api2ValidData = jsonData.data.shipment;
      }
    } catch (err) {
      console.log(`【接口2】查询失败，丢弃，错误信息：${err.message}`);
    }

    // 接口2拿到有效数据，直接返回，终止流程
    if (api2ValidData) {
      return res.json({
        code: 0,
        source: "api2",
        data: api2ValidData
      });
    }

    // ====================== 第三步：查询接口3（内网三段式） ======================
    console.log("接口1、2全部无有效数据/查询失败，进入接口3查询");
    const api3Cfg = CONFIG.api3;
    let api3HasValid = false;
    let api3ReturnData = [];

    // 循环三种单号类型依次尝试
    for (const type of api3Cfg.types) {
      try {
        const reqBody = {
          authorization: { code: api3Cfg.clientCode, token: api3Cfg.apiToken },
          datas: { [type]: [inputNo] }
        };
        const abortCtrl = new AbortController();
        const timer = setTimeout(() => abortCtrl.abort(), api3Cfg.timeoutMs);
        const resp = await fetch(api3Cfg.targetUrl, {
          method: "POST",
          signal: abortCtrl.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reqBody)
        });
        clearTimeout(timer);

        if (!resp.ok) throw new Error(`HTTP状态码${resp.status}`);
        const jsonData = await resp.json();
        console.log(`【接口3-${type}】返回原始数据：`, jsonData);

        // 判断当前类型是否查到有效运单
        if (jsonData.code === 0 && jsonData.data && jsonData.data.length > 0 && !jsonData.data[0].errormsg) {
          api3HasValid = true;
          api3ReturnData = jsonData.data;
          break; // 当前类型成功，跳出循环，不再尝试剩余类型
        }
      } catch (err) {
        // 当前type查询失败，丢弃，继续下一种单号类型
        console.log(`【接口3-${type}】查询失败，丢弃，错误信息：${err.message}`);
        continue;
      }
    }

    // 接口3任意一种类型查到数据，直接返回
    if (api3HasValid) {
      return res.json({
        code: 0,
        source: "api3",
        data: api3ReturnData
      });
    }

    // 1、2、3全部渠道无有效数据
    return res.json({
      code: 3,
      msg: "单号错误，请核对"
    });

  } catch (globalErr) {
    console.error("中转服务全局致命异常：", globalErr);
    let msg = "中转服务异常";
    if (globalErr.name === "AbortError") msg = "上游接口请求超时";
    return res.json({ code: -99, msg, error: globalErr.message });
  }
});

// 健康检测路由
app.get("/", (req, res) => {
  res.send("代理服务运行正常 | 顺序容错查询1→2→3");
});

// 拦截非法请求方式
app.all("/", (req, res) => {
  return res.json({ code: -1, msg: "仅支持POST查询请求" });
});

app.listen(PORT, () => {
  console.log(`统一容错中转服务启动成功，监听端口：${PORT}`);
});
