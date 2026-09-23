import fs from "node:fs";
import { extractSourceBody } from "./corpus-extraction.js";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const stagingPath = option("--input");
  const mime = option("--mime");
  const stat = await fs.promises.stat(stagingPath);
  if (!stat.isFile()) {
    throw new Error("extractor input is not a regular file");
  }
  const handle = await fs.promises.open(stagingPath, "r");
  let head: Buffer;
  try {
    head = Buffer.alloc(Math.min(512 * 1024, stat.size));
    const result = await handle.read(head, 0, head.length, 0);
    head = head.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
  const result = await extractSourceBody({ stagingPath, mime, head });
  process.stdout.write(`${JSON.stringify({ status: result.status })}\n`);
  if (result.body) {
    process.stdout.write(result.body);
  }
}

void main().then(
  () => process.exit(0),
  () => process.exit(70),
);
