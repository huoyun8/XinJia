const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const app = express();
const PORT = process.env.PORT || 10000;

// 跨域配置
app.use(cors({
  origin: "*",
  allowedHeaders: ["Content-Type"],
  methods: ["POST", "OPTIONS", "GET"]
}));
app.use(express.json({ limit: "10kb" }));

// 仅保留本地接口配置
const CONFIG = {
  timeoutMs: 8000,
  localApi: {
    host: "http://120.79.98.64:1888",
    path: "/prod-api/order/track/html/getTrackByTrackNoNumberList",
    secretkey: "n6VD8BDmTUhmoljTMT41Uw96%3D%3D"
  }
};

// OPTIONS预检
app.options("/", (req, res) => {
  res.sendStatus(200);
});

/**
 * 仅保留：120.79.98.64 XML接口查询 + XML转统一JSON结构
 */
async function queryLocalApi(trackNo) {
  try {
    // 拼接带鉴权secretkey的GET请求链接
    const urlParams = new URLSearchParams();
    urlParams.set("waybillStr", trackNo);
    urlParams.set("secretkey", CONFIG.localApi.secretkey);
    const fullUrl = `${CONFIG.localApi.host}${CONFIG.localApi.path}?${urlParams.toString()}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
    const resp = await fetch(fullUrl, {
      method: "GET",
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!resp.ok) throw new Error(`HTTP状态码${resp.status}`);

    const xmlText = await resp.text();
    // 简易XML文本提取工具
    const extractXmlText = (xml, tag) => {
      const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      return match ? match[1].trim() : "";
    };

    const rootCode = extractXmlText(xmlText, "code");
    const rootMsg = extractXmlText(xmlText, "msg");
    if (rootCode !== "200") throw new Error(`接口返回失败:${rootMsg}`);

    // 提取业务字段
    const searchNumber = extractXmlText(xmlText, "searchNumber");
    const trackNumber = extractXmlText(xmlText, "trackNumber");
    const destination = extractXmlText(xmlText, "destination");
    const orderStatus = extractXmlText(xmlText, "orderStatus");
    const trackInfo = extractXmlText(xmlText, "trackInfo");
    const trackDate = extractXmlText(xmlText, "trackDate");
    const location = extractXmlText(xmlText, "location");

    // 无物流轨迹判定
    if (!trackInfo && !trackDate) {
      return { success: false, msg: "该单号暂无物流轨迹数据" };
    }

    // 转为前端兼容的统一数据结构
    const formatItem = {
      tracknumber: trackNumber,
      waybillnumber: searchNumber,
      countrycode: "",
      countryname: destination,
      orderstatus: orderStatus || "运输中",
      orderstatusName: orderStatus || "运输中",
      trackItems: [{ trackdate: trackDate, info: trackInfo, location }],
      subOrderList: [],
      subOrderTrackItems: {}
    };
    return { success: true, data: [formatItem] };
  } catch (err) {
    console.log("本地接口查询异常:", err.message);
    return { success: false, msg: err.message };
  }
}

// 核心POST中转接口
app.post("/", async (req, res) => {
  try {
    const inputNo = (req.body.trackNo || "").trim();
    console.log("收到查询单号：", inputNo);

    // 单号校验（和前端规则统一）
    if (!inputNo) return res.json({ code: -2, msg: "运单号不能为空" });
    if (inputNo.length < 5 || inputNo.length > 18) return res.json({ code: -2, msg: "单号长度需5-18位，请检查" });

    // 调用唯一接口查询
    const apiRes = await queryLocalApi(inputNo);

    if (apiRes.success) {
      // 查询到数据，兼容前端原有解析逻辑
      return res.json({
        code: 0,
        msg: "查询成功",
        data: apiRes.data
      });
    } else {
      // 无数据返回
      return res.json({
        code: -1,
        msg: apiRes.msg,
        data: []
      });
    }
  } catch (err)
    console.error("中转服务全局异常：", err);
    let msg = "中转服务异常";
    if (err.name === "AbortError") msg = "上游接口请求超时";
    return res.json({ code: -99, msg, error: err.message, data: [] });
  }
});

// 健康检测GET
app.get("/", (req, res) => {
  res.send("中转服务运行正常 | 仅对接接口：http://120.79.98.64:1888");
});

// 拦截非POST请求
app.all("/", (req, res) => {
  return res.json({ code: -1, msg: "仅支持POST查询请求" });
});

app.listen(PORT, () => {
  console.log(`中转服务启动成功，监听端口:${PORT}`);
  console.log("上游查询接口：http://120.79.98.64:1888/prod-api/order/track/html/getTrackByTrackNoNumberList");
});
