// 版本测试 v2：再改一次，版本号应该再次变化
/**
 * Car Control Tool — Gemini 调用此工具控制车辆功能
 *
 * 通过 JS Bridge (Android.carControl) 调用 Android 原生层。
 * 在非车载环境（普通浏览器）中返回模拟响应，方便开发调试。
 *
 * JS Bridge 原理：
 *   Android 壳 App 启动时执行 webView.addJavascriptInterface(carBridge, "Android")
 *   把 Kotlin 的 CarBridge 对象注入到 JS 全局变量 window.Android 上。
 *   JS 调用 Android.carControl() → WebView 引擎自动转发 → Kotlin CarBridge.carControl()
 */
class CarControlTool extends FunctionCallDefinition {
  constructor() {
    super(
      "car_control",
      "控制车辆功能。用户说'开空调'、'调到25度'、'打开座椅加热'、'关窗户'等车控指令时调用此工具。",
      {
        type: "object",
        properties: {
          action: {
            type: "string",
            description:
              "操作类型: set_ac_temperature | set_ac_power | set_ac_mode | set_seat_heat | set_window | start_navigation",
          },
          params: {
            type: "object",
            description:
              "操作参数，如 {temperature: 25}、{on: true}、{mode: 'cool'}、{seat: 'driver', level: 2}、{position: 'driver', open: true}、{destination: '锦里老灶火锅', address: '人民路123号'}",
          },
        },
      },
      ["action"],
    );
  }

  functionToCall(parameters) {
    const { action, params } = parameters;
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[${ts}] CAR_CONTROL | action=${action} | params=${JSON.stringify(params)}`);

    // 通过 JS Bridge 调用 Android 原生层
    if (typeof Android !== "undefined" && Android.carControl) {
      try {
        const resultJson = Android.carControl(action, JSON.stringify(params || {}));
        const result = JSON.parse(resultJson);
        console.log(`[${ts}] CAR_CONTROL | result=${JSON.stringify(result)}`);
        return result;
      } catch (e) {
        console.error(`[${ts}] CAR_CONTROL | JS Bridge error:`, e);
        return { ok: false, error: `JS Bridge 调用失败: ${e.message}` };
      }
    }

    // 非车载环境（普通浏览器）— 模拟响应，方便手机/电脑调试
    console.warn(`[${ts}] CAR_CONTROL | 非车载环境，返回模拟响应`);
    return simulateCarControl(action, params);
  }
}

/**
 * 模拟车控响应（非车载环境调试用）
 */
function simulateCarControl(action, params) {
  switch (action) {
    case "set_ac_temperature": {
      const temp = params?.temperature ?? 24;
      return { ok: true, message: `[模拟] 空调温度已设为${temp}度` };
    }
    case "set_ac_power": {
      const on = params?.on ?? true;
      return { ok: true, message: `[模拟] 空调已${on ? "打开" : "关闭"}` };
    }
    case "set_ac_mode": {
      const mode = params?.mode ?? "auto";
      const modeNames = { cool: "制冷", heat: "制热", auto: "自动" };
      return {
        ok: true,
        message: `[模拟] 空调模式已切换为${modeNames[mode] || mode}`,
      };
    }
    case "set_seat_heat": {
      const seat = params?.seat === "passenger" ? "副驾" : "主驾";
      const level = params?.level ?? 1;
      return {
        ok: true,
        message: `[模拟] ${seat}座椅加热已设为${level}档`,
      };
    }
    case "set_window": {
      const pos = params?.position === "passenger" ? "副驾" : "主驾";
      const open = params?.open ?? true;
      return {
        ok: true,
        message: `[模拟] ${pos}车窗已${open ? "打开" : "关闭"}`,
      };
    }
    case "start_navigation": {
      const dest = params?.destination ?? "未知目的地";
      const addr = params?.address ?? "";
      const msg = addr ? `[模拟] 已开始导航到${dest}（${addr}）` : `[模拟] 已开始导航到${dest}`;
      console.log(`🧭 NAV | destination=${dest} address=${addr}`);
      return { ok: true, message: msg };
    }
    default:
      return { ok: false, error: `[模拟] 未知操作: ${action}` };
  }
}
