"use strict";

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MRIYtdParser = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  const MAGIC_RSC7 = 0x37435352;
  const VIRTUAL_BASE = 0x50000000n;
  const PHYSICAL_BASE = 0x60000000n;
  const DEFAULT_MAX_INFLATED = 768 * 1024 * 1024;
  const MAX_TEXTURES = 4096;

  const DX9_FORMATS = new Map([
    [0x31545844, ["BC1 / DXT1", 8, false, 0]],
    [0x33545844, ["BC2 / DXT3", 16, false, 1]],
    [0x35545844, ["BC3 / DXT5", 16, false, 2]],
    [0x31495441, ["BC4 / ATI1", 8, false, 3]],
    [0x32495441, ["BC5 / ATI2", 16, false, 4]],
    [0x20374342, ["BC7", 16, false, 5]],
    [21, ["A8R8G8B8", 4, true, 6]],
    [28, ["A8", 1, true, 8]],
    [25, ["B5G5R5A1", 2, true, 11]],
    [23, ["B5G6R5", 2, true, 10]],
    [50, ["R8", 1, true, 9]],
  ]);
  const DXGI_FORMATS = new Map([
    [71, ["BC1", 8, false, 0]], [72, ["BC1 sRGB", 8, false, 0]],
    [74, ["BC2", 16, false, 1]], [75, ["BC2 sRGB", 16, false, 1]],
    [77, ["BC3", 16, false, 2]], [78, ["BC3 sRGB", 16, false, 2]],
    [80, ["BC4", 8, false, 3]], [83, ["BC5", 16, false, 4]],
    [98, ["BC7", 16, false, 5]], [99, ["BC7 sRGB", 16, false, 5]],
    [28, ["R8G8B8A8", 4, true, 7]], [87, ["B8G8R8A8", 4, true, 6]],
    [61, ["R8", 1, true, 9]], [65, ["A8", 1, true, 8]],
    [85, ["B5G6R5", 2, true, 10]], [86, ["B5G5R5A1", 2, true, 11]],
  ]);

  class YtdParseError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "YtdParseError";
      this.code = code;
    }
  }

  function segmentSize(flags) {
    const pageUnits =
      (((flags >>> 27) & 1) << 0) +
      (((flags >>> 26) & 1) << 1) +
      (((flags >>> 25) & 1) << 2) +
      (((flags >>> 24) & 1) << 3) +
      (((flags >>> 17) & 0x7f) << 4) +
      (((flags >>> 11) & 0x3f) << 5) +
      (((flags >>> 7) & 0x0f) << 6) +
      (((flags >>> 5) & 0x03) << 7) +
      (((flags >>> 4) & 0x01) << 8);
    return (0x200 * Math.pow(2, flags & 0x0f)) * pageUnits;
  }

  function flagsForSize(size, versionNibble) {
    if (!size) return (((versionNibble & 0x0f) << 28) >>> 0);
    const capacities = [1, 3, 15, 63, 127, 1, 1, 1, 1];
    const weights = [256, 128, 64, 32, 16, 8, 4, 2, 1];
    let best = null;
    for (let pass = 0; pass < 2 && !best; pass += 1) {
      const chunkLimit = pass === 0 ? 64 : 128;
      for (let shift = 0; shift <= 15; shift += 1) {
        const blockBytes = 0x200 * Math.pow(2, shift);
        const roundedBytes = Math.ceil(size / blockBytes) * blockBytes;
        let remaining = roundedBytes / blockBytes;
        const counts = new Array(9).fill(0);
        for (let index = 0; index < weights.length; index += 1) {
          counts[index] = Math.min(capacities[index], Math.floor(remaining / weights[index]));
          remaining -= counts[index] * weights[index];
        }
        if (remaining) continue;
        const chunks = counts.reduce(function (sum, count) { return sum + count; }, 0);
        if (chunks > chunkLimit) continue;
        if (!best || roundedBytes < best.roundedBytes || (roundedBytes === best.roundedBytes && chunks < best.chunks)) {
          best = { shift: shift, roundedBytes: roundedBytes, chunks: chunks, counts: counts };
        }
      }
    }
    if (!best) throw new YtdParseError("FLAGS_UNREPRESENTABLE", "O novo segmento físico não cabe na tabela de páginas RSC7.");
    const counts = best.counts;
    return (((versionNibble & 0x0f) << 28) |
      ((counts[8] & 1) << 27) | ((counts[7] & 1) << 26) | ((counts[6] & 1) << 25) |
      ((counts[5] & 1) << 24) | ((counts[4] & 0x7f) << 17) | ((counts[3] & 0x3f) << 11) |
      ((counts[2] & 0x0f) << 7) | ((counts[1] & 0x03) << 5) | ((counts[0] & 1) << 4) |
      (best.shift & 0x0f)) >>> 0;
  }

  function assertRange(offset, length, total, label) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > total) {
      throw new YtdParseError("OUT_OF_BOUNDS", label + " aponta para fora do container RSC7.");
    }
  }

  function pointerOffset(view, fieldOffset, base, segmentLength) {
    assertRange(fieldOffset, 8, view.byteLength, "Ponteiro");
    const pointer = view.getBigUint64(fieldOffset, true);
    if (pointer < base) return null;
    const relative = pointer - base;
    if (relative > BigInt(segmentLength) || relative > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(relative);
  }

  function readCString(bytes, offset, limit) {
    if (offset < 0 || offset >= limit) return "";
    let end = offset;
    const cap = Math.min(limit, offset + 512);
    while (end < cap && bytes[end] !== 0) end += 1;
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(offset, end)).trim();
  }

  function mipBytes(width, height, format, mipCount) {
    let total = 0;
    let w = width;
    let h = height;
    for (let level = 0; level < mipCount; level += 1) {
      if (format[2]) total += w * h * format[1];
      else total += Math.max(1, Math.ceil(w / 4)) * Math.max(1, Math.ceil(h / 4)) * format[1];
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
    }
    return total;
  }

  async function inflateRaw(compressed, expectedBytes) {
    if (typeof DecompressionStream !== "function") {
      throw new YtdParseError("NO_DEFLATE_RAW", "Este navegador não oferece descompressão local de RSC7.");
    }
    let inflater;
    try {
      inflater = new DecompressionStream("deflate-raw");
    } catch (_) {
      throw new YtdParseError("NO_DEFLATE_RAW", "Este navegador não suporta o formato deflate-raw usado por YTD.");
    }
    const chunks = [];
    let totalBytes = 0;
    try {
      const stream = new Blob([compressed]).stream().pipeThrough(inflater);
      const reader = stream.getReader();
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        totalBytes += part.value.byteLength;
        if (totalBytes > expectedBytes) {
          await reader.cancel();
          throw new YtdParseError("INFLATED_OVERFLOW", "O RSC7 expandiu além do tamanho declarado no cabeçalho.");
        }
        chunks.push(part.value);
      }
    } catch (_) {
      if (_ instanceof YtdParseError) throw _;
      throw new YtdParseError("INFLATE_FAILED", "O payload RSC7 está corrompido ou usa uma variante ainda não suportada.");
    }
    if (totalBytes < expectedBytes) {
      throw new YtdParseError("TRUNCATED_PAYLOAD", "O RSC7 descompactado é menor que o tamanho declarado no cabeçalho.");
    }
    const output = new Uint8Array(expectedBytes);
    let cursor = 0;
    chunks.forEach(function (chunk) {
      output.set(chunk, cursor);
      cursor += chunk.byteLength;
    });
    return output;
  }

  async function sha256(bytes) {
    if (!globalThis.crypto || !globalThis.crypto.subtle) return "";
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), function (value) { return value.toString(16).padStart(2, "0"); }).join("");
  }

  async function inspect(input, options) {
    const source = input instanceof Uint8Array ? input : new Uint8Array(input);
    const settings = options || {};
    if (source.byteLength < 16) throw new YtdParseError("TOO_SMALL", "O arquivo é pequeno demais para ser um YTD RSC7.");
    const header = new DataView(source.buffer, source.byteOffset, source.byteLength);
    if (header.getUint32(0, true) !== MAGIC_RSC7) throw new YtdParseError("BAD_MAGIC", "O arquivo não possui a assinatura RSC7 esperada.");

    const version = header.getUint32(4, true);
    const systemFlags = header.getUint32(8, true);
    const graphicsFlags = header.getUint32(12, true);
    const systemBytes = segmentSize(systemFlags);
    const graphicsBytes = segmentSize(graphicsFlags);
    const inflatedBytes = systemBytes + graphicsBytes;
    const maxInflatedBytes = settings.maxInflatedBytes || DEFAULT_MAX_INFLATED;
    if (!inflatedBytes || inflatedBytes > maxInflatedBytes) {
      throw new YtdParseError("INFLATED_LIMIT", "O YTD declara " + inflatedBytes + " bytes descompactados e excede o limite local.");
    }

    const payload = await inflateRaw(source.subarray(16), inflatedBytes);
    const system = payload.subarray(0, systemBytes);
    const graphics = payload.subarray(systemBytes);
    if (system.byteLength < 0x40) throw new YtdParseError("BAD_SYSTEM_SEGMENT", "O segmento virtual do YTD é inválido.");
    const systemView = new DataView(system.buffer, system.byteOffset, system.byteLength);
    const textureCount = systemView.getUint16(0x28, true);
    if (!textureCount || textureCount > MAX_TEXTURES) throw new YtdParseError("BAD_TEXTURE_COUNT", "Quantidade de texturas inválida: " + textureCount + ".");
    const itemTable = pointerOffset(systemView, 0x30, VIRTUAL_BASE, systemBytes);
    if (itemTable === null) throw new YtdParseError("BAD_ITEM_TABLE", "A tabela de texturas do YTD é inválida.");
    assertRange(itemTable, textureCount * 8, systemBytes, "Tabela de texturas");

    const enhanced = version === 5;
    const structureBytes = enhanced ? 0x80 : 0x90;
    const formatTable = enhanced ? DXGI_FORMATS : DX9_FORMATS;
    const textures = [];
    let rejectedTextures = 0;
    for (let index = 0; index < textureCount; index += 1) {
      const structure = pointerOffset(systemView, itemTable + index * 8, VIRTUAL_BASE, systemBytes);
      if (structure === null || structure + structureBytes > systemBytes) { rejectedTextures += 1; continue; }
      const nameOffset = pointerOffset(systemView, structure + 0x28, VIRTUAL_BASE, systemBytes);
      if (nameOffset === null) { rejectedTextures += 1; continue; }
      const name = readCString(system, nameOffset, systemBytes);
      const widthOffset = enhanced ? 0x40 : 0x50;
      const width = systemView.getInt16(structure + widthOffset, true);
      const height = systemView.getInt16(structure + widthOffset + 2, true);
      const stride = systemView.getInt16(structure + (enhanced ? 0x46 : 0x56), true);
      const formatCode = systemView.getUint32(structure + (enhanced ? 0x48 : 0x58), true);
      const mipCount = systemView.getUint8(structure + (enhanced ? 0x4d : 0x5d));
      const dataOffset = pointerOffset(systemView, structure + (enhanced ? 0x60 : 0x70), PHYSICAL_BASE, graphicsBytes);
      const format = formatTable.get(formatCode);
      if (!name || width <= 0 || height <= 0 || !mipCount || !format || dataOffset === null) { rejectedTextures += 1; continue; }
      const dataBytes = mipBytes(width, height, format, mipCount);
      if (dataOffset + dataBytes > graphicsBytes) { rejectedTextures += 1; continue; }
      const textureData = graphics.subarray(dataOffset, dataOffset + dataBytes);
      textures.push({
        index: index,
        name: name,
        width: width,
        height: height,
        stride: stride,
        format: format[0],
        formatCode: formatCode,
        codecFormat: format[3],
        compressed: !format[2],
        mipCount: mipCount,
        dataBytes: dataBytes,
        dataHash: settings.hashTextures === false ? "" : await sha256(textureData),
        structureOffset: settings.internal ? structure : undefined,
        dataOffset: settings.internal ? dataOffset : undefined,
      });
    }
    if (!textures.length) throw new YtdParseError("NO_TEXTURES", "Nenhuma textura compatível foi encontrada dentro do YTD.");
    const result = {
      version: version,
      generation: enhanced ? "Enhanced / Gen9" : "Legacy",
      compressedBytes: source.byteLength,
      systemBytes: systemBytes,
      graphicsBytes: graphicsBytes,
      inflatedBytes: inflatedBytes,
      declaredTextures: textureCount,
      rejectedTextures: rejectedTextures,
      textureBytes: textures.reduce(function (sum, texture) { return sum + texture.dataBytes; }, 0),
      textures: textures,
    };
    if (settings.internal) {
      result.source = source;
      result.payload = payload;
      result.system = system;
      result.graphics = graphics;
      result.systemFlags = systemFlags;
      result.graphicsFlags = graphicsFlags;
      result.enhanced = enhanced;
    }
    return result;
  }

  async function open(input, options) {
    return inspect(input, Object.assign({}, options || {}, { internal: true, hashTextures: false }));
  }

  return { inspect: inspect, open: open, segmentSize: segmentSize, flagsForSize: flagsForSize, YtdParseError: YtdParseError };
});
