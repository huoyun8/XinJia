const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({
  origin: "*",
  allowedHeaders: ["Content-Type"],
  methods: ["POST", "OPTIONS", "GET"]
}));
app.use(express.json({ limit: "10kb" }));

const CONFIG = {
  timeoutMs: 8000,
  localApi: {
    host: "http://120.79.98.64:1888",
    path: "/prod-api/order/track/html/getTrackByTrackNoNumberList",
    secretkey: "n6VD8BDmTUhmoljTMT41Uw96%253D%253D"
  }
};

app.options("/", (req, res) => {
  res.sendStatus(200);
});

async function queryLocalApi(trackNo) {
  try {
    const urlParams = new URLSearchParams();
    urlParams.set("waybillStr", trackNo);
    urlParams.set("secretkey", CONFIG.localApi.secretkey);
    const fullUrl = `${CONFIG.localApi.host}${CONFIG.localApi.path}?${urlParams.toString()}`;
    console.log("上游完整请求地址：", fullUrl);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
    const resp = await fetch(fullUrl, {
      method: "GET",
      signal: controller.signal
    });
    clearTimeout(timer);

    console.log("上游HTTP状态码：", resp.status);
    const rawText = await resp.text();
    console.log("上游原始返回：", rawText);

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      throw new Error("返回不是合法JSON");
    }
    console.log("解析后的JSON：", data);

    if (data.code !== 200) {
      throw new Error(`${data.msg || "接口业务错误"}, code:${data.code}`);
    }

    // 根据上游返回JSON结构，提取物流信息
    // 注意：这里需要看成功时返回的JSON字段，先预留结构
    if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
      return { success: false, msg: "该单号暂无物流轨迹数据" };
    }

    const item = data.data[0];
    const formatItem = {
      tracknumber: item.trackNumber || "",
      waybillnumber: item.searchNumber || "",
      countrycode: "",
      countryname: item.destination || "",
      orderstatus: item.orderStatus || "运输中",
      orderstatusName: item.orderStatus || "运输中",
      trackItems: [
        {
          trackdate: item.trackDate || "",
          info: item.trackInfo || "",
          location: item.location || ""
        }
      ],
      subOrderList: [],
      subOrderTrackItems: {}
    };
    return { success: true, data: [formatItem] };
  } catch (err) {
    console.error("查询捕获异常：", err);
    return { success: false, msg: err.message };
  }
}

app.post("/", async (req, res) => {
  try {
    const inputNo = (req.body.trackNo || "").trim();
    console.log("收到查询单号：", inputNo);

    if (!inputNo) return res.json({ code: -2, msg: "运单号不能为空", data: [] });
    if (inputNo.length < 5 || inputNo.length > 18) return res.json({ code: -2, msg: "单号长度需5-18位，请检查", data: [] });

    const apiResult = await queryLocalApi(inputNo);
    if (apiResult.success) {
      return res.json({
        code: 0,
        msg: "查询成功",
        data: apiResult.data
      });
    } else {
      return res.json({
        code: -1,
        msg: apiResult.msg,
        data: []
      });
    }
  } catch (err) {
    console.error("全局异常：", err);
    let msg = "中转服务异常";
    if (err.name === "AbortError") msg = "上游接口请求超时";
    return res.json({ code: -99, msg, error: err.message, data: [] });
  }
});

// 调试路由
app.get("/debug", async (req, res) => {
  const trackNo = req.query.no || "";
  if (!trackNo) return res.send("用法 /debug?no=单号");
  const ret = await queryLocalApi(trackNo);
  res.json(ret);
});

app.get("/", (req, res) => {
  res.send("中转服务运行正常");
});

app.all("*", (req, res) => {
  return res.json({ code: -1, msg: "仅支持POST查询请求", data: [] });
});

app.listen(PORT, () => {
  console.log(`中转服务启动成功，端口:${PORT}`);
});
