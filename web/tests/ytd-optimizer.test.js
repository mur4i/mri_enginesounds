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

function duplicateOnlyFixture() {
  const systemBytes = 512;
  const textureBytes = 24;
  const graphicsFlags = global.MRIYtdParser.flagsForSize(textureBytes * 2, 13);
  const graphicsBytes = global.MRIYtdParser.segmentSize(graphicsFlags);
  const payload = new Uint8Array(systemBytes + graphicsBytes);
  const system = new DataView(payload.buffer, 0, systemBytes);
  const structures = [0x50, 0xe0];
  const names = [0x170, 0x180];
  system.setUint16(0x28, 2, true);
  pointer(system, 0x30, 0x50000040);
  structures.forEach(function (structure, index) {
    pointer(system, 0x40 + index * 8, 0x50000000 + structure);
    pointer(system, structure + 0x28, 0x50000000 + names[index]);
    system.setInt16(structure + 0x50, 4, true);
    system.setInt16(structure + 0x52, 4, true);
    system.setInt16(structure + 0x56, 8, true);
    system.setUint32(structure + 0x58, 0x31545844, true);
    system.setUint8(structure + 0x5d, 3);
    pointer(system, structure + 0x70, 0x60000000 + index * textureBytes);
    payload.set(new TextEncoder().encode("duplicate_" + index + "\0"), names[index]);
  });
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

function alphaTextureFixture(allMipsOpaque, legacyFormat) {
  const systemBytes = 512;
  const textureBytes = 32;
  const graphicsFlags = global.MRIYtdParser.flagsForSize(textureBytes, 13);
  const graphicsBytes = global.MRIYtdParser.segmentSize(graphicsFlags);
  const payload = new Uint8Array(systemBytes + graphicsBytes);
  const system = new DataView(payload.buffer, 0, systemBytes);
  const structure = 0x50;
  system.setUint16(0x28, 1, true);
  pointer(system, 0x30, 0x50000040);
  pointer(system, 0x40, 0x50000000 + structure);
  pointer(system, structure + 0x28, 0x500000e0);
  system.setInt16(structure + 0x50, 4, true);
  system.setInt16(structure + 0x52, 4, true);
  system.setInt16(structure + 0x56, 16, true);
  system.setUint32(structure + 0x58, legacyFormat, true);
  system.setUint8(structure + 0x5d, 2);
  pointer(system, structure + 0x70, 0x60000000);
  payload.set(new TextEncoder().encode("opaque_bc3\0"), 0xe0);

  for (let mip = 0; mip < 2; mip += 1) {
    const block = systemBytes + mip * 16;
    if (mip === 0 || allMipsOpaque) payload.fill(0xff, block, block + 8);
    payload.set([0x1f, 0x00, 0x00, 0xf8, 0x67, 0x45, 0x23, 0x01], block + 8);
  }
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

  const duplicateResult = await global.MRIYtdOptimizer.optimize(duplicateOnlyFixture(), {
    maxDimension: 4096,
    maxMips: 13,
    quality: 2,
    generateMipmaps: true,
    allowDowngrade: false,
  });
  const duplicateModel = await global.MRIYtdParser.open(new Uint8Array(duplicateResult.buffer));
  assert.equal(duplicateResult.changed, true);
  assert.equal(duplicateResult.optimizedTextures, 0);
  assert.equal(duplicateResult.dedupedTextures, 1);
  assert.equal(duplicateResult.afterTextureBytes, 24);
  assert.equal(duplicateModel.textures[0].dataOffset, duplicateModel.textures[1].dataOffset);

  const profile = {
    maxDimension: 4096,
    maxMips: 13,
    quality: 1,
    generateMipmaps: true,
    allowDowngrade: true,
  };
  const downgradeResult = await global.MRIYtdOptimizer.optimize(alphaTextureFixture(true, 0x35545844), profile);
  const downgradeModel = await global.MRIYtdParser.open(new Uint8Array(downgradeResult.buffer));
  const color = downgradeModel.graphics.subarray(0, 8);
  assert.equal(downgradeResult.changed, true);
  assert.equal(downgradeResult.formatDowngrades, 1);
  assert.equal(downgradeResult.afterTextureBytes, 16);
  assert.equal(downgradeModel.textures[0].format, "BC1 / DXT1");
  assert.equal(downgradeModel.textures[0].mipCount, 2);
  assert.deepEqual(Array.from(color.subarray(0, 4)), [0x00, 0xf8, 0x1f, 0x00]);
  assert.equal(new DataView(color.buffer, color.byteOffset + 4, 4).getUint32(0, true), (0x01234567 ^ 0x55555555) >>> 0);

  const bc2Result = await global.MRIYtdOptimizer.optimize(alphaTextureFixture(true, 0x33545844), profile);
  assert.equal(bc2Result.changed, true);
  assert.equal(bc2Result.formatDowngrades, 1);
  assert.equal(bc2Result.afterTextureBytes, 16);

  const protectedAlphaResult = await global.MRIYtdOptimizer.optimize(alphaTextureFixture(false, 0x35545844), profile);
  assert.equal(protectedAlphaResult.changed, false);
  assert.equal(protectedAlphaResult.optimizedTextures, 0);
  console.log("ytd-optimizer: ok");
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
