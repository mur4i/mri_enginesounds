"use strict";

const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const parser = require("../assets/ytd-parser.js");

function writePointer(view, offset, value) {
  view.setBigUint64(offset, BigInt(value), true);
}

function makeFixture() {
  const systemBytes = 512;
  const graphicsBytes = 32768;
  const payload = new Uint8Array(systemBytes + graphicsBytes);
  const system = new DataView(payload.buffer, 0, systemBytes);
  const structureOffset = 0x50;
  system.setUint16(0x28, 1, true);
  writePointer(system, 0x30, 0x50000040);
  writePointer(system, 0x40, 0x50000000 + structureOffset);
  writePointer(system, structureOffset + 0x28, 0x500000e0);
  system.setInt16(structureOffset + 0x50, 256, true);
  system.setInt16(structureOffset + 0x52, 256, true);
  system.setInt16(structureOffset + 0x56, 512, true);
  system.setUint32(structureOffset + 0x58, 0x31545844, true);
  system.setUint8(structureOffset + 0x5d, 1);
  writePointer(system, structureOffset + 0x70, 0x60000000);
  payload.set(new TextEncoder().encode("vehicle_diffuse\0"), 0xe0);
  payload.fill(0x5a, systemBytes);

  const compressed = zlib.deflateRawSync(payload);
  const file = new Uint8Array(16 + compressed.byteLength);
  const header = new DataView(file.buffer);
  header.setUint32(0, 0x37435352, true);
  header.setUint32(4, 13, true);
  header.setUint32(8, 0x08000000, true);
  header.setUint32(12, 0x08000006, true);
  file.set(compressed, 16);
  return file;
}

(async function () {
  assert.equal(parser.segmentSize(0x08000000), 512);
  assert.equal(parser.segmentSize(0x08000006), 32768);

  const report = await parser.inspect(makeFixture());
  assert.equal(report.generation, "Legacy");
  assert.equal(report.declaredTextures, 1);
  assert.equal(report.rejectedTextures, 0);
  assert.equal(report.textureBytes, 32768);
  assert.deepEqual(
    {
      name: report.textures[0].name,
      width: report.textures[0].width,
      height: report.textures[0].height,
      format: report.textures[0].format,
      mipCount: report.textures[0].mipCount,
      compressed: report.textures[0].compressed,
    },
    { name: "vehicle_diffuse", width: 256, height: 256, format: "BC1 / DXT1", mipCount: 1, compressed: true },
  );
  assert.equal(report.textures[0].dataHash.length, 64);

  const invalid = makeFixture();
  invalid[0] = 0;
  await assert.rejects(parser.inspect(invalid), function (error) { return error.code === "BAD_MAGIC"; });
  console.log("ytd-parser: ok");
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
