import { GatewayClient } from "../src/gateway/client.js";

async function main() {
  let connected = false;
  const client = new GatewayClient({
    url: "ws://localhost:29031",
    token: "carher-container-token",
    clientName: "test-chat",
    onHelloOk: () => {
      connected = true;
    },
    onConnectError: (e: Error) => {
      console.error("连接错误:", e.message);
      process.exit(1);
    },
  });

  for (let i = 0; i < 40; i++) {
    if (connected) {
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!connected) {
    console.error("连接超时");
    process.exit(1);
  }
  console.log("已连接到 docker4 gateway");

  try {
    const result = await client.request("message.send", {
      message: "你好，请用一句话简短回复：你是谁？",
      sessionKey: "test-connectivity-check",
    });
    console.log("回复:", JSON.stringify(result, null, 2));
  } catch (e) {
    console.error("发送失败:", (e as Error).message);
  }

  client.stop();
  process.exit(0);
}

void main();
