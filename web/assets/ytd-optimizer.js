"use strict";

(function (root, factory) {
  root.MRIYtdOptimizer = factory(root);
})(typeof self !== "undefined" ? self : globalThis, function (root) {
  const PHYSICAL_BASE = 0x60000000n;
  let codecPromise = null;

  function optimizerError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  async function getCodec() {
    if (!codecPromise) {
      if (typeof root.createEOTextureCodec !== "function") {
        if (typeof importScripts !== "function") throw optimizerError("NO_WASM_LOADER", "O codec WebAssembly só pode ser executado em um Worker.");
        importScripts("eo-texture-codec.js");
      }
      codecPromise = root.createEOTextureCodec({
        locateFile: function (path) { return path.endsWith(".wasm") ? "eo-texture-codec.wasm" : path; },
      });
    }
    return codecPromise;
  }

  function shouldOptimize(texture, profile) {
    const largestSide = Math.max(texture.width, texture.height);
    return largestSide > profile.maxDimension || (profile.generateMipmaps && texture.mipCount <= 1 && largestSide >= 512);
  }

  function largeMipBytes(width, height, format, mipCount) {
    let total = 0;
    let w = width;
    let h = height;
    for (let mip = 0; mip < mipCount; mip += 1) {
      if (w >= 16 && h >= 16) total += levelBytes(w, h, format);
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
    }
    return total;
  }

  function levelBytes(width, height, codecFormat) {
    if (codecFormat <= 5) {
      const blockBytes = codecFormat === 0 || codecFormat === 3 ? 8 : 16;
      return Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * blockBytes;
    }
    const pixelBytes = codecFormat === 6 || codecFormat === 7 ? 4 : codecFormat >= 10 ? 2 : 1;
    return width * height * pixelBytes;
  }

  function optimizeTexture(codec, texture, bytes, profile) {
    const input = codec._malloc(bytes.byteLength);
    if (!input) throw optimizerError("WASM_OOM", "O WebAssembly ficou sem memória ao carregar " + texture.name + ".");
    try {
      codec.HEAPU8.set(bytes, input);
      const output = codec._eo_optimize_texture(
        input,
        bytes.byteLength,
        texture.width,
        texture.height,
        texture.codecFormat,
        profile.maxDimension,
        profile.maxMips || 13,
        profile.quality,
      );
      if (!output) {
        throw optimizerError("WASM_CODEC_" + codec._eo_last_error(), "O codec não conseguiu processar " + texture.name + ".");
      }
      const size = codec._eo_last_size();
      return {
        data: codec.HEAPU8.slice(output, output + size),
        width: codec._eo_last_width(),
        height: codec._eo_last_height(),
        mipCount: codec._eo_last_mips(),
        stride: codec._eo_last_stride(),
      };
    } finally {
      codec._eo_release_output();
      codec._free(input);
    }
  }

  async function compressRaw(bytes) {
    if (typeof CompressionStream !== "function") throw optimizerError("NO_COMPRESSION_STREAM", "Este navegador não consegue reconstruir o RSC7 localmente.");
    let compressor;
    try { compressor = new CompressionStream("deflate-raw"); }
    catch (_) { throw optimizerError("NO_COMPRESSION_STREAM", "Este navegador não suporta deflate-raw para salvar YTD."); }
    const reader = new Blob([bytes]).stream().pipeThrough(compressor).getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(part.value);
      total += part.value.byteLength;
    }
    const result = new Uint8Array(total);
    let cursor = 0;
    chunks.forEach(function (chunk) { result.set(chunk, cursor); cursor += chunk.byteLength; });
    return result;
  }

  async function optimize(input, profile, onProgress) {
    if (!root.MRIYtdParser) throw optimizerError("NO_YTD_PARSER", "O leitor YTD não foi carregado.");
    const model = await root.MRIYtdParser.open(input);
    if (model.enhanced) throw optimizerError("ENHANCED_READ_ONLY", "YTD Enhanced/Gen9 permanece somente leitura nesta versão.");
    if (model.rejectedTextures || model.textures.length !== model.declaredTextures) {
      throw optimizerError("PARTIAL_PARSE", "O YTD contém texturas desconhecidas e foi preservado para evitar corrupção.");
    }
    const candidates = model.textures.filter(function (texture) { return shouldOptimize(texture, profile); });
    if (!candidates.length) {
      return { buffer: model.source.slice().buffer, changed: false, optimizedTextures: 0, beforeBytes: model.source.byteLength, afterBytes: model.source.byteLength };
    }

    const codec = await getCodec();
    const replacements = new Map();
    for (let index = 0; index < candidates.length; index += 1) {
      const texture = candidates[index];
      if (onProgress) onProgress({ current: index + 1, total: candidates.length, name: texture.name });
      const source = model.graphics.subarray(texture.dataOffset, texture.dataOffset + texture.dataBytes);
      replacements.set(texture.index, optimizeTexture(codec, texture, source, profile));
    }

    const textureData = model.textures.map(function (texture) {
      const replacement = replacements.get(texture.index);
      return replacement || {
        data: model.graphics.slice(texture.dataOffset, texture.dataOffset + texture.dataBytes),
        width: texture.width,
        height: texture.height,
        mipCount: texture.mipCount,
        stride: texture.stride,
      };
    });
    const usedGraphicsBytes = textureData.reduce(function (sum, item) { return sum + item.data.byteLength; }, 0);
    const versionNibble = model.graphicsFlags >>> 28;
    const graphicsFlags = root.MRIYtdParser.flagsForSize(usedGraphicsBytes, versionNibble);
    const graphicsTargetBytes = root.MRIYtdParser.segmentSize(graphicsFlags);
    const payload = new Uint8Array(model.systemBytes + graphicsTargetBytes);
    payload.set(model.system, 0);
    const systemView = new DataView(payload.buffer, 0, model.systemBytes);
    let graphicsCursor = 0;
    model.textures.forEach(function (texture, index) {
      const item = textureData[index];
      payload.set(item.data, model.systemBytes + graphicsCursor);
      const structure = texture.structureOffset;
      systemView.setUint32(structure + 0x40, largeMipBytes(item.width, item.height, texture.codecFormat, item.mipCount), true);
      systemView.setUint16(structure + 0x50, item.width, true);
      systemView.setUint16(structure + 0x52, item.height, true);
      systemView.setUint16(structure + 0x56, item.stride, true);
      systemView.setUint8(structure + 0x5d, item.mipCount);
      systemView.setBigUint64(structure + 0x70, PHYSICAL_BASE + BigInt(graphicsCursor), true);
      graphicsCursor += item.data.byteLength;
    });

    const compressed = await compressRaw(payload);
    const output = new Uint8Array(16 + compressed.byteLength);
    const header = new DataView(output.buffer);
    header.setUint32(0, 0x37435352, true);
    header.setUint32(4, model.version, true);
    header.setUint32(8, model.systemFlags, true);
    header.setUint32(12, graphicsFlags, true);
    output.set(compressed, 16);
    return {
      buffer: output.buffer,
      changed: true,
      optimizedTextures: replacements.size,
      beforeBytes: model.source.byteLength,
      afterBytes: output.byteLength,
      beforeTextureBytes: model.textureBytes,
      afterTextureBytes: usedGraphicsBytes,
    };
  }

  return { optimize: optimize };
});
