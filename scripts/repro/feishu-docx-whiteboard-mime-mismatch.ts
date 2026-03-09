import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sniffMimeFromBase64 } from "../../src/media/sniff-mime-from-base64.js";

type Fixture = {
  capturedIssue: {
    source: string;
    capturedAt: string;
    title: string;
    declaredMimeType: string;
    sniffedMimeType: string;
    base64Prefix: string;
    byteLength: number;
  };
  simulatedDoc: {
    title: string;
    docToken: string;
    blocks: Array<{ block_id: string; block_type: number; board?: { token?: string } }>;
    downloadedWhiteboardImage: {
      contentType: string;
      base64: string;
    };
  };
};

function loadFixture(): Fixture {
  const fixturePath = resolve(
    process.cwd(),
    "test/fixtures/feishu-docx-whiteboard-jpeg-mime-mismatch.json",
  );
  return JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;
}

async function main() {
  const fixture = loadFixture();
  const simulatedBase64 = fixture.simulatedDoc.downloadedWhiteboardImage.base64;
  const downloadedMime = fixture.simulatedDoc.downloadedWhiteboardImage.contentType;
  const sniffedMime = await sniffMimeFromBase64(simulatedBase64);

  if (!sniffedMime) {
    throw new Error("fixture image MIME could not be detected from base64");
  }

  const oldInlineMime = "image/png";
  const fixedInlineMime = sniffedMime ?? downloadedMime;

  const report = {
    capturedIssue: fixture.capturedIssue,
    simulatedDoc: {
      title: fixture.simulatedDoc.title,
      docToken: fixture.simulatedDoc.docToken,
      blockCount: fixture.simulatedDoc.blocks.length,
      downloadedMime,
      sniffedMime,
    },
    reproduction: {
      oldImplementation: {
        inlineMime: oldInlineMime,
        mismatch: oldInlineMime !== sniffedMime,
      },
      fixedImplementation: {
        inlineMime: fixedInlineMime,
        mismatch: fixedInlineMime !== sniffedMime,
      },
    },
  };

  if (!report.reproduction.oldImplementation.mismatch) {
    throw new Error("old implementation no longer reproduces the MIME mismatch");
  }
  if (report.reproduction.fixedImplementation.mismatch) {
    throw new Error("fixed implementation still produces a MIME mismatch");
  }

  console.log(JSON.stringify(report, null, 2));
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
