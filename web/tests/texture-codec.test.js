"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const assets = path.resolve(__dirname, "../assets");
const createCodec = require(path.join(assets, "eo-texture-codec.js"));

(async function () {
  const codec = await createCodec({ locateFile: function (name) { return path.join(assets, name); } });
  const cases = [
    { format: 2, data: new Uint8Array(16) },
    { format: 5, data: new Uint8Array([0x40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
  ];
  for (const item of cases) {
    const input = codec._malloc(item.data.length);
    codec.HEAPU8.set(item.data, input);
    const output = codec._eo_optimize_texture(input, item.data.length, 4, 4, item.format, 4, 4, 1);
    assert.ok(output, "codec format " + item.format + " returned error " + codec._eo_last_error());
    assert.equal(codec._eo_last_size(), 48);
    assert.equal(codec._eo_last_mips(), 3);
    codec._eo_release_output();
    codec._free(input);
  }
  console.log("texture-codec: ok");
})().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
