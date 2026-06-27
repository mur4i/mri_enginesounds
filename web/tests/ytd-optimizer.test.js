"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const zlib = require("node:zlib");

const assets = path.resolve(__dirname, "../assets");
process.chdir(assets);
global.MRIYtdParser = require(path.join(assets, "ytd-parser.js"));
global.createEOTextureCodec = require(path.join(assets, "eo-texture-codec.js"));
require(path.join(assets, "ytd-optimizer.js"));

function pointer(view, offset, value) { view.setBigUint64(offset, BigInt(value), true); }

function fixture() {
  const systemBytes = 512;
  const textureBytes = 128 * 128 * 8;
  const graphicsFlags = global.MRIYtdParser.flagsForSize(textureBytes, 13);
  const graphicsBytes = global.MRIYtdParser.segmentSize(graphicsFlags);
  const payload = new Uint8Array(systemBytes + graphicsBytes);
  const system = new DataView(payload.buffer, 0, systemBytes);
  const structure = 0x50;
  system.setUint16(0x28, 1, true);
  pointer(system, 0x30, 0x50000040);
  pointer(system, 0x40, 0x50000000 + structure);
  pointer(system, structure + 0x28, 0x500000e0);
  system.setInt16(structure + 0x50, 512, true);
  system.setInt16(structure + 0x52, 512, true);
  system.setInt16(structure + 0x56, 1024, true);
  system.setUint32(structure + 0x58, 0x31545844, true);
  system.setUint8(structure + 0x5d, 1);
  pointer(system, structure + 0x70, 0x60000000);
  payload.set(new TextEncoder().encode("vehicle_4k_test\0"), 0xe0);

  const compressed = zlib.deflateRawSync(payload);
  const file = new Uint8Array(16 + compressed.length);
  const header = new DataView(file.buffer);
  header.setUint32(0, 0x37435352, true);
  header.setUint32(4, 13, true);
  header.setUint32(8, 0x08000000, true);
  header.setUint32(12, graphicsFlags, true);
  file.set(compressed, 16);
  return file;
}

(async function () {
  const source = fixture();
  const result = await global.MRIYtdOptimizer.optimize(source, {
    maxDimension: 256,
    maxMips: 13,
    quality: 1,
    generateMipmaps: true,
  });
  const report = await global.MRIYtdParser.inspect(new Uint8Array(result.buffer));
  assert.equal(result.changed, true);
  assert.equal(result.optimizedTextures, 1);
  assert.equal(report.declaredTextures, 1);
  assert.equal(report.rejectedTextures, 0);
  assert.equal(report.textures[0].width, 256);
  assert.equal(report.textures[0].height, 256);
  assert.equal(report.textures[0].mipCount, 9);
  assert.equal(report.textures[0].format, "BC1 / DXT1");
  assert.ok(report.textureBytes < 128 * 128 * 8);
  console.log("ytd-optimizer: ok");
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
