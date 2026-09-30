// 两个 nextsls 查询接口(不同服务商, 依次尝试, 取第一个有数据的)
const NEXT_SLS_APIS = [
  "https://tracking.nextsls.com/rest/trace/tracking/lists?app=656d92f573f0427e8e5ca536&number=",
  "https://tracking.nextsls.com/rest/trace/tracking/lists?app=67204e5c73f04246486924cb&number="
];

// nextsls 中转: 依次尝试 1、2 号, 返回第一个有数据的
app.post("/nextsls", async (req, res) => {
  try {
    const inputNo = (req.body.trackNo || "").trim();
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
        if (json && json.status === 1 && json.data && json.data.shipment) return res.json(json);
      } catch (err) { clearTimeout(timer); last = { status: 0, info: "查询异常", error: err.message }; }
    }
    return res.json(last);
  } catch (err) { return res.json({ status: 0, info: "中转服务异常", error: err.message }); }
});
