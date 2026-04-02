import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import sharp from "sharp";
import { registerFeishuDocTools } from "../../extensions/feishu-her/src/tools/docx.js";

type FeishuConfig = {
  channels?: {
    feishu?: {
      appId?: string;
      appSecret?: string;
    };
  };
};

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{ content?: unknown; details: unknown }>;
};

type DriveListResponse = {
  code: number;
  msg?: string;
  data?: {
    files?: Array<{
      type?: string;
      parent_token?: string;
    }>;
  };
};

type DocCreateResponse = {
  code: number;
  msg?: string;
  data?: {
    document?: {
      document_id?: string;
    };
  };
};

type BlockChildrenCreateResponse = {
  code: number;
  msg?: string;
  data?: {
    children?: Array<{
      block_type?: number;
      block_id?: string;
    }>;
  };
};

type DocPatchResponse = {
  code: number;
  msg?: string;
};

type DriveDeleteResponse = {
  code: number;
  msg?: string;
};

type DriveUploadResponse = {
  file_token?: string;
};

function readConfig(): FeishuConfig {
  const configPath = resolve(process.cwd(), "docker/user-configs/carher-config-1.json");
  return JSON.parse(readFileSync(configPath, "utf8")) as FeishuConfig;
}

function getFeishuClient(cfg: FeishuConfig) {
  const appId = cfg.channels?.feishu?.appId?.trim();
  const appSecret = cfg.channels?.feishu?.appSecret?.trim();
  if (!appId || !appSecret) {
    throw new Error("missing local docker1 Feishu credentials");
  }

  return new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu,
  });
}

async function findWritableFolderToken(client: Lark.Client): Promise<string> {
  const res = (await client.drive.file.list({
    params: { page_size: 20 },
  })) as DriveListResponse;
  if (res.code !== 0) {
    throw new Error(`drive.file.list failed: ${res.msg}`);
  }

  const file = (res.data?.files ?? []).find(
    (item) => item.type === "docx" && typeof item.parent_token === "string" && item.parent_token,
  );
  if (!file?.parent_token) {
    throw new Error("no writable folder_token found from local docker1 drive list");
  }
  return file.parent_token;
}

async function createDocWithInlineImage(client: Lark.Client, folderToken: string) {
  const createRes = (await client.docx.document.create({
    data: {
      title: `inline-image-live-validate-${Date.now()}`,
      folder_token: folderToken,
    },
  })) as DocCreateResponse;
  if (createRes.code !== 0) {
    throw new Error(`document.create failed: ${createRes.msg}`);
  }

  const docToken = createRes.data?.document?.document_id;
  if (!docToken) {
    throw new Error("document.create missing document_id");
  }

  const insertRes = (await client.docx.documentBlockChildren.create({
    path: { document_id: docToken, block_id: docToken },
    params: { document_revision_id: -1 },
    data: {
      children: [{ block_type: 27, image: {} as Record<string, never> }],
      index: -1,
    },
  })) as BlockChildrenCreateResponse;
  if (insertRes.code !== 0) {
    throw new Error(`documentBlockChildren.create failed: ${insertRes.msg}`);
  }

  const imageBlockId = insertRes.data?.children?.find((block) => block.block_type === 27)?.block_id;
  if (!imageBlockId) {
    throw new Error("missing image block id");
  }

  const imageBuffer = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 80, g: 170, b: 220, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  const uploadRes = (await client.drive.media.uploadAll({
    data: {
      file_name: "inline-image-live-validate.png",
      parent_type: "docx_image",
      parent_node: imageBlockId,
      size: imageBuffer.length,
      file: imageBuffer as unknown,
      extra: JSON.stringify({ drive_route_token: docToken }),
    },
  })) as DriveUploadResponse;
  const fileToken = uploadRes?.file_token;
  if (!fileToken) {
    throw new Error("drive.media.uploadAll missing file_token");
  }

  const patchRes = (await client.docx.documentBlock.patch({
    path: { document_id: docToken, block_id: imageBlockId },
    data: { replace_image: { token: fileToken } },
  })) as DocPatchResponse;
  if (patchRes.code !== 0) {
    throw new Error(`documentBlock.patch failed: ${patchRes.msg}`);
  }

  return { docToken, imageBlockId };
}

function getFeishuDocTool(cfg: FeishuConfig): RegisteredTool {
  const tools: RegisteredTool[] = [];
  const registerTool = (tool: RegisteredTool) => {
    tools.push(tool);
  };
  registerFeishuDocTools({
    config: cfg,
    logger: { info: () => {} },
    registerTool,
  } as unknown as OpenClawPluginApi);

  const tool = tools.find((item) => item.name === "feishu_doc");
  if (!tool) {
    throw new Error("failed to register feishu_doc");
  }
  return tool;
}

function getImageBlocks(result: { content?: unknown }) {
  const content = Array.isArray(result.content) ? result.content : [];
  return content.filter(
    (block): block is { type: "image"; data: string; mimeType: string } =>
      !!block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "image" &&
      typeof (block as { data?: unknown }).data === "string" &&
      typeof (block as { mimeType?: unknown }).mimeType === "string",
  );
}

async function cleanupDoc(client: Lark.Client, docToken: string) {
  const deleteRes = (await client.drive.file.delete({
    path: { file_token: docToken },
    params: { type: "docx" as never },
  })) as DriveDeleteResponse;
  if (deleteRes.code !== 0) {
    throw new Error(`drive.file.delete failed: ${deleteRes.msg}`);
  }
}

async function main() {
  const cfg = readConfig();
  const client = getFeishuClient(cfg);
  const folderToken = await findWritableFolderToken(client);
  const { docToken } = await createDocWithInlineImage(client, folderToken);
  const tool = getFeishuDocTool(cfg);

  try {
    const readResult = await tool.execute("live-read", {
      action: "read",
      doc_token: docToken,
    });
    const readImages = getImageBlocks(readResult);
    if (readImages.length !== 1) {
      throw new Error(`expected 1 image from feishu_doc read, got ${readImages.length}`);
    }
    if (readImages[0]?.mimeType !== "image/png") {
      throw new Error(`expected read image mimeType=image/png, got ${readImages[0]?.mimeType}`);
    }

    const listBlocksResult = await tool.execute("live-list-blocks", {
      action: "list_blocks",
      doc_token: docToken,
    });
    const listImages = getImageBlocks(listBlocksResult);
    if (listImages.length !== 1) {
      throw new Error(`expected 1 image from feishu_doc list_blocks, got ${listImages.length}`);
    }
    if (listImages[0]?.mimeType !== "image/png") {
      throw new Error(
        `expected list_blocks image mimeType=image/png, got ${listImages[0]?.mimeType}`,
      );
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          docToken,
          folderToken,
          readImageMimeTypes: readImages.map((image) => image.mimeType),
          listBlocksImageMimeTypes: listImages.map((image) => image.mimeType),
        },
        null,
        2,
      ),
    );
  } finally {
    await cleanupDoc(client, docToken);
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
