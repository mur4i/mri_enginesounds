"use strict";

(function (root, factory) {
  root.MRIYtdOptimizer = factory(root);
})(typeof self !== "undefined" ? self : globalThis, function (root) {
  const PHYSICAL_BASE = 0x60000000n;
  // codecFormat (índice do codec) -> código de formato DX9 legacy (escrito na struct do YTD).
  // Usado só quando o formato muda (ex.: downgrade BC3->BC1).
  const LEGACY_FORMAT_CODES = {
    0: 0x31545844, // BC1 / DXT1
    1: 0x33545844, // BC2 / DXT3
    2: 0x35545844, // BC3 / DXT5
    3: 0x31495441, // BC4 / ATI1
    4: 0x32495441, // BC5 / ATI2
    5: 0x20374342, // BC7
  };
  let codecPromise = null;

  // Classifica a textura pelo nome (conservador: só rebaixa quando tem certeza;
  // tudo o que não casa = "diffuse" e mantém a resolução alta, pra não borrar o carro).
  function textureRole(name) {
    const n = (name || "").toLowerCase();
    if (n.indexOf("normal") >= 0 || n.indexOf("_nrm") >= 0 || /_n\d*$/.test(n)) return "normal";
    if (n.indexOf("spec") >= 0) return "spec";
    if (n.indexOf("dirt") >= 0 || n.indexOf("grunge") >= 0 || n.indexOf("grime") >= 0) return "dirt";
    if (n.indexOf("detail") >= 0) return "detail";
    return "diffuse";
  }
  function effectiveMaxDimension(texture, profile) {
    if (!profile.roleCaps) return profile.maxDimension;
    const cap = profile.roleCaps[textureRole(texture.name)];
    return cap ? Math.min(profile.maxDimension, cap) : profile.maxDimension;
  }

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
    if (largestSide > effectiveMaxDimension(texture, profile)) return true;
    if (profile.generateMipmaps && texture.mipCount <= 1 && largestSide >= 512) return true;
    // BC2/BC3 podem virar BC1 sem re-encode quando todos os blocos alpha,
    // em todos os mipmaps, forem totalmente opacos.
    if (profile.allowDowngrade && (texture.codecFormat === 1 || texture.codecFormat === 2)) return true;
    return false;
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

  // Stride RAGE = bytes por LINHA DE PIXEL. Para formato em bloco é o tamanho da
  // linha de blocos dividido por 4 (altura do bloco): ceil(w/4)*blockBytes/4.
  // (o WASM e o downgrade calculavam ceil(w/4)*blockBytes = 4x grande -> cisalhava)
  function strideFor(width, codecFormat) {
    if (codecFormat <= 5) {
      const blockBytes = codecFormat === 0 || codecFormat === 3 ? 8 : 16;
      return Math.max(1, Math.ceil(width / 4)) * (blockBytes / 4);
    }
    const pixelBytes = codecFormat === 6 || codecFormat === 7 ? 4 : codecFormat >= 10 ? 2 : 1;
    return width * pixelBytes;
  }

  function bc3AlphaPalette(a0, a1) {
    const palette = [a0, a1];
    if (a0 > a1) {
      for (let index = 2; index < 8; index += 1) {
        palette[index] = Math.floor(((8 - index) * a0 + (index - 1) * a1) / 7);
      }
    } else {
      for (let index = 2; index < 6; index += 1) {
        palette[index] = Math.floor(((6 - index) * a0 + (index - 1) * a1) / 5);
      }
      palette[6] = 0;
      palette[7] = 255;
    }
    return palette;
  }

  function blockAlphaIsOpaque(bytes, offset, codecFormat) {
    if (codecFormat === 1) {
      for (let index = 0; index < 8; index += 1) {
        if (bytes[offset + index] !== 255) return false;
      }
      return true;
    }
    if (codecFormat !== 2) return false;
    const palette = bc3AlphaPalette(bytes[offset], bytes[offset + 1]);
    let indices = 0;
    for (let index = 0; index < 6; index += 1) {
      indices += bytes[offset + 2 + index] * (2 ** (index * 8));
    }
    for (let pixel = 0; pixel < 16; pixel += 1) {
      const paletteIndex = Math.floor(indices / (2 ** (pixel * 3))) % 8;
      if (palette[paletteIndex] !== 255) return false;
    }
    return true;
  }

  function alphaChainIsOpaque(texture, bytes) {
    let offset = 0;
    let width = texture.width;
    let height = texture.height;
    for (let mip = 0; mip < texture.mipCount; mip += 1) {
      const blocks = Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4));
      const mipBytes = blocks * 16;
      if (offset + mipBytes > bytes.byteLength) return false;
      for (let block = 0; block < blocks; block += 1) {
        if (!blockAlphaIsOpaque(bytes, offset + block * 16, texture.codecFormat)) return false;
      }
      offset += mipBytes;
      width = Math.max(1, Math.floor(width / 2));
      height = Math.max(1, Math.floor(height / 2));
    }
    return offset === bytes.byteLength;
  }

  function writeBc1ColorBlock(source, sourceOffset, target, targetOffset) {
    const colorOffset = sourceOffset + 8;
    const c0 = source[colorOffset] | (source[colorOffset + 1] << 8);
    const c1 = source[colorOffset + 2] | (source[colorOffset + 3] << 8);
    let indices = (
      source[colorOffset + 4]
      | (source[colorOffset + 5] << 8)
      | (source[colorOffset + 6] << 16)
      | (source[colorOffset + 7] << 24)
    ) >>> 0;
    let out0 = c0;
    let out1 = c1;
    if (c0 < c1) {
      out0 = c1;
      out1 = c0;
      indices = (indices ^ 0x55555555) >>> 0;
    } else if (c0 === c1) {
      if (c0 > 0) {
        out1 = c0 - 1;
        indices = 0;
      } else {
        out0 = 1;
        out1 = 0;
        indices = 0x55555555;
      }
    }
    target[targetOffset] = out0 & 255;
    target[targetOffset + 1] = out0 >>> 8;
    target[targetOffset + 2] = out1 & 255;
    target[targetOffset + 3] = out1 >>> 8;
    target[targetOffset + 4] = indices & 255;
    target[targetOffset + 5] = (indices >>> 8) & 255;
    target[targetOffset + 6] = (indices >>> 16) & 255;
    target[targetOffset + 7] = indices >>> 24;
  }

  function downgradeOpaqueToBc1(texture, bytes) {
    if (!alphaChainIsOpaque(texture, bytes)) return null;
    let outputBytes = 0;
    let width = texture.width;
    let height = texture.height;
    for (let mip = 0; mip < texture.mipCount; mip += 1) {
      outputBytes += levelBytes(width, height, 0);
      width = Math.max(1, Math.floor(width / 2));
      height = Math.max(1, Math.floor(height / 2));
    }
    const output = new Uint8Array(outputBytes);
    let sourceOffset = 0;
    let targetOffset = 0;
    width = texture.width;
    height = texture.height;
    for (let mip = 0; mip < texture.mipCount; mip += 1) {
      const blocks = Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4));
      for (let block = 0; block < blocks; block += 1) {
        writeBc1ColorBlock(bytes, sourceOffset + block * 16, output, targetOffset + block * 8);
      }
      sourceOffset += blocks * 16;
      targetOffset += blocks * 8;
      width = Math.max(1, Math.floor(width / 2));
      height = Math.max(1, Math.floor(height / 2));
    }
    return {
      data: output,
      width: texture.width,
      height: texture.height,
      mipCount: texture.mipCount,
      stride: Math.max(1, Math.ceil(texture.width / 4)) * 8,
      codecFormat: 0,
    };
  }

  async function optimizeTexture(texture, bytes, profile) {
    const largestSide = Math.max(texture.width, texture.height);
    const needsResize = largestSide > effectiveMaxDimension(texture, profile);
    const forceGenerateMipmaps = profile.generateMipmaps && texture.mipCount <= 1 && largestSide >= 512;
    if (profile.allowDowngrade && (texture.codecFormat === 1 || texture.codecFormat === 2)
        && !needsResize && !forceGenerateMipmaps) {
      return downgradeOpaqueToBc1(texture, bytes);
    }
    if (!needsResize && !forceGenerateMipmaps) return null;

    const codec = await getCodec();
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
        effectiveMaxDimension(texture, profile),
        profile.maxMips || 13,
        profile.quality,
        0,
        texture.mipCount,
      );
      if (!output) {
        // no-op: nada a ganhar nessa textura -> mantém a original (sem perda)
        if (typeof codec._eo_last_noop === "function" && codec._eo_last_noop()) return null;
        throw optimizerError("WASM_CODEC_" + codec._eo_last_error(), "O codec não conseguiu processar " + texture.name + ".");
      }
      const size = codec._eo_last_size();
      const replacement = {
        data: codec.HEAPU8.slice(output, output + size),
        width: codec._eo_last_width(),
        height: codec._eo_last_height(),
        mipCount: codec._eo_last_mips(),
        stride: codec._eo_last_stride(),
        codecFormat: typeof codec._eo_last_format === "function" ? codec._eo_last_format() : texture.codecFormat,
      };
      if (profile.allowDowngrade && (replacement.codecFormat === 1 || replacement.codecFormat === 2)) {
        return downgradeOpaqueToBc1(replacement, replacement.data) || replacement;
      }
      return replacement;
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

  // chave rápida (FNV-1a + tamanho) p/ agrupar candidatos a dedup; igualdade confirmada byte a byte.
  function bytesKey(data) {
    let h = 0x811c9dc5;
    for (let i = 0; i < data.length; i += 1) { h ^= data[i]; h = Math.imul(h, 0x01000193); }
    return (h >>> 0) + ":" + data.length;
  }
  function bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) { if (a[i] !== b[i]) return false; }
    return true;
  }
  function hasSourceDuplicates(model) {
    const seen = new Map();
    for (let i = 0; i < model.textures.length; i += 1) {
      const t = model.textures[i];
      const data = model.graphics.subarray(t.dataOffset, t.dataOffset + t.dataBytes);
      const key = bytesKey(data);
      const bucket = seen.get(key);
      if (bucket) { for (let b = 0; b < bucket.length; b += 1) { if (bytesEqual(bucket[b], data)) return true; } bucket.push(data); }
      else seen.set(key, [data]);
    }
    return false;
  }

  async function optimize(input, profile, onProgress) {
    if (!root.MRIYtdParser) throw optimizerError("NO_YTD_PARSER", "O leitor YTD não foi carregado.");
    const model = await root.MRIYtdParser.open(input);
    if (model.enhanced) throw optimizerError("ENHANCED_READ_ONLY", "YTD Enhanced/Gen9 permanece somente leitura nesta versão.");
    if (model.rejectedTextures || model.textures.length !== model.declaredTextures) {
      throw optimizerError("PARTIAL_PARSE", "O YTD contém texturas desconhecidas e foi preservado para evitar corrupção.");
    }
    const candidates = model.textures.filter(function (texture) { return shouldOptimize(texture, profile); });
    const hasDuplicates = hasSourceDuplicates(model);
    if (!candidates.length && !hasDuplicates) {
      return { buffer: model.source.slice().buffer, changed: false, optimizedTextures: 0, beforeBytes: model.source.byteLength, afterBytes: model.source.byteLength };
    }

    const replacements = new Map();
    for (let index = 0; index < candidates.length; index += 1) {
      const texture = candidates[index];
      if (onProgress) onProgress({ current: index + 1, total: candidates.length, name: texture.name });
      const source = model.graphics.subarray(texture.dataOffset, texture.dataOffset + texture.dataBytes);
      const replacement = await optimizeTexture(texture, source, profile);
      if (replacement) replacements.set(texture.index, replacement);
    }
    if (!replacements.size && !hasDuplicates) {
      return { buffer: model.source.slice().buffer, changed: false, optimizedTextures: 0, beforeBytes: model.source.byteLength, afterBytes: model.source.byteLength };
    }

    const textureData = model.textures.map(function (texture) {
      const replacement = replacements.get(texture.index);
      return replacement || {
        data: model.graphics.slice(texture.dataOffset, texture.dataOffset + texture.dataBytes),
        width: texture.width,
        height: texture.height,
        mipCount: texture.mipCount,
        stride: texture.stride,
        codecFormat: texture.codecFormat,
      };
    });
    // Dedup seguro DENTRO do YTD: texturas com dados byte-idênticos apontam para
    // o mesmo bloco gráfico (nomes preservados; o dado é escrito uma única vez).
    const dataOffsets = new Array(model.textures.length);
    const dedupSeen = [];
    let uniqueBytes = 0, dedupSaved = 0, dedupCount = 0;
    textureData.forEach(function (item, index) {
      const key = bytesKey(item.data);
      let offset = -1;
      for (let s = 0; s < dedupSeen.length; s += 1) {
        if (dedupSeen[s].key === key && bytesEqual(dedupSeen[s].data, item.data)) { offset = dedupSeen[s].offset; break; }
      }
      if (offset >= 0) { dataOffsets[index] = offset; dedupSaved += item.data.byteLength; dedupCount += 1; }
      else { dataOffsets[index] = uniqueBytes; dedupSeen.push({ key: key, offset: uniqueBytes, data: item.data }); uniqueBytes += item.data.byteLength; }
    });
    const usedGraphicsBytes = uniqueBytes;
    const versionNibble = model.graphicsFlags >>> 28;
    const graphicsFlags = root.MRIYtdParser.flagsForSize(usedGraphicsBytes, versionNibble);
    const graphicsTargetBytes = root.MRIYtdParser.segmentSize(graphicsFlags);
    const payload = new Uint8Array(model.systemBytes + graphicsTargetBytes);
    payload.set(model.system, 0);
    const systemView = new DataView(payload.buffer, 0, model.systemBytes);
    const writtenOffsets = new Set();
    let formatDowngrades = 0;
    let resizes = 0;
    model.textures.forEach(function (texture, index) {
      const item = textureData[index];
      const outFormat = typeof item.codecFormat === "number" ? item.codecFormat : texture.codecFormat;
      const offset = dataOffsets[index];
      if (!writtenOffsets.has(offset)) { payload.set(item.data, model.systemBytes + offset); writtenOffsets.add(offset); }
      const structure = texture.structureOffset;
      systemView.setUint32(structure + 0x40, largeMipBytes(item.width, item.height, outFormat, item.mipCount), true);
      systemView.setUint16(structure + 0x50, item.width, true);
      systemView.setUint16(structure + 0x52, item.height, true);
      systemView.setUint16(structure + 0x56, strideFor(item.width, outFormat), true);
      systemView.setUint8(structure + 0x5d, item.mipCount);
      // formato mudou (ex.: downgrade BC3->BC1): atualiza o código de formato na struct
      if (outFormat !== texture.codecFormat && LEGACY_FORMAT_CODES[outFormat] !== undefined) {
        systemView.setUint32(structure + 0x58, LEGACY_FORMAT_CODES[outFormat], true);
        formatDowngrades += 1;
      }
      if (item.width < texture.width || item.height < texture.height) resizes += 1;
      systemView.setBigUint64(structure + 0x70, PHYSICAL_BASE + BigInt(offset), true);
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
      formatDowngrades: formatDowngrades,
      resizes: resizes,
      dedupedTextures: dedupCount,
      dedupedBytes: dedupSaved,
    };
  }

  return { optimize: optimize };
});
