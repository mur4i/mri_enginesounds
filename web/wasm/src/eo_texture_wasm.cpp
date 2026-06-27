// MRI browser texture codec
// Derived from the texture pipeline in EasyOptimizer-V.
// Copyright (C) 2026 LN-Development and MRI contributors.
// SPDX-License-Identifier: GPL-3.0-only

#include <emscripten/emscripten.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <algorithm>

#include "rgbcx.h"
#include "bc7enc.h"
#include "bc7decomp.h"

#define STB_IMAGE_RESIZE_IMPLEMENTATION
#include "stb_image_resize2.h"

enum TextureFormat {
    FORMAT_BC1 = 0,
    FORMAT_BC2 = 1,
    FORMAT_BC3 = 2,
    FORMAT_BC4 = 3,
    FORMAT_BC5 = 4,
    FORMAT_BC7 = 5,
    FORMAT_BGRA8 = 6,
    FORMAT_RGBA8 = 7,
    FORMAT_A8 = 8,
    FORMAT_R8 = 9,
    FORMAT_B5G6R5 = 10,
    FORMAT_B5G5R5A1 = 11,
};

static uint8_t *g_output = nullptr;
static size_t g_output_size = 0;
static int g_output_width = 0;
static int g_output_height = 0;
static int g_output_mips = 0;
static int g_output_stride = 0;
static int g_last_error = 0;
static bool g_initialized = false;

static bool is_block_format(int format) { return format >= FORMAT_BC1 && format <= FORMAT_BC7; }

static int block_bytes(int format) {
    return (format == FORMAT_BC1 || format == FORMAT_BC4) ? 8 : 16;
}

static int pixel_bytes(int format) {
    if (format == FORMAT_BGRA8 || format == FORMAT_RGBA8) return 4;
    if (format == FORMAT_B5G6R5 || format == FORMAT_B5G5R5A1) return 2;
    if (format == FORMAT_A8 || format == FORMAT_R8) return 1;
    return 0;
}

static size_t level_size(int width, int height, int format) {
    if (is_block_format(format)) {
        int bw = std::max(1, (width + 3) / 4);
        int bh = std::max(1, (height + 3) / 4);
        return (size_t)bw * bh * block_bytes(format);
    }
    return (size_t)width * height * pixel_bytes(format);
}

static int row_pitch(int width, int format) {
    if (is_block_format(format)) return std::max(1, (width + 3) / 4) * block_bytes(format);
    return width * pixel_bytes(format);
}

static void initialize_codec() {
    if (g_initialized) return;
    rgbcx::init();
    bc7enc_compress_block_init();
    g_initialized = true;
}

static void decode_bc2_alpha(const uint8_t *source, uint8_t *rgba) {
    for (int y = 0; y < 4; y++) {
        uint16_t row = (uint16_t)(source[y * 2] | (source[y * 2 + 1] << 8));
        for (int x = 0; x < 4; x++) rgba[(y * 4 + x) * 4 + 3] = (uint8_t)(((row >> (x * 4)) & 0xf) * 17);
    }
}

static bool decode_base(const uint8_t *source, size_t source_size, int width, int height,
                        int format, uint8_t *rgba) {
    size_t expected = level_size(width, height, format);
    if (!source || !rgba || source_size < expected) return false;
    if (is_block_format(format)) {
        int bw = std::max(1, (width + 3) / 4);
        int bh = std::max(1, (height + 3) / 4);
        int bytes = block_bytes(format);
        for (int by = 0; by < bh; by++) {
            for (int bx = 0; bx < bw; bx++) {
                const uint8_t *block = source + ((size_t)by * bw + bx) * bytes;
                uint8_t pixels[64] = {0};
                switch (format) {
                    case FORMAT_BC1: rgbcx::unpack_bc1(block, pixels); break;
                    case FORMAT_BC2:
                        rgbcx::unpack_bc1(block + 8, pixels);
                        decode_bc2_alpha(block, pixels);
                        break;
                    case FORMAT_BC3: rgbcx::unpack_bc3(block, pixels); break;
                    case FORMAT_BC4:
                        rgbcx::unpack_bc4(block, pixels, 4);
                        for (int i = 0; i < 16; i++) {
                            pixels[i * 4 + 1] = pixels[i * 4];
                            pixels[i * 4 + 2] = pixels[i * 4];
                            pixels[i * 4 + 3] = 255;
                        }
                        break;
                    case FORMAT_BC5:
                        rgbcx::unpack_bc5(block, pixels, 0, 1, 4);
                        for (int i = 0; i < 16; i++) {
                            pixels[i * 4 + 2] = 255;
                            pixels[i * 4 + 3] = 255;
                        }
                        break;
                    case FORMAT_BC7:
                        if (!bc7decomp::unpack_bc7(block, (bc7decomp::color_rgba *)pixels)) return false;
                        break;
                    default: return false;
                }
                for (int py = 0; py < 4 && by * 4 + py < height; py++) {
                    for (int px = 0; px < 4 && bx * 4 + px < width; px++) {
                        memcpy(rgba + ((size_t)(by * 4 + py) * width + bx * 4 + px) * 4,
                               pixels + (py * 4 + px) * 4, 4);
                    }
                }
            }
        }
        return true;
    }

    size_t pixels = (size_t)width * height;
    for (size_t i = 0; i < pixels; i++) {
        switch (format) {
            case FORMAT_BGRA8:
                rgba[i * 4] = source[i * 4 + 2]; rgba[i * 4 + 1] = source[i * 4 + 1];
                rgba[i * 4 + 2] = source[i * 4]; rgba[i * 4 + 3] = source[i * 4 + 3];
                break;
            case FORMAT_RGBA8: memcpy(rgba + i * 4, source + i * 4, 4); break;
            case FORMAT_A8:
                rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = source[i];
                break;
            case FORMAT_R8:
                rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = source[i]; rgba[i * 4 + 3] = 255;
                break;
            case FORMAT_B5G6R5: {
                uint16_t value = (uint16_t)(source[i * 2] | (source[i * 2 + 1] << 8));
                rgba[i * 4] = (uint8_t)(((value >> 11) & 31) * 255 / 31);
                rgba[i * 4 + 1] = (uint8_t)(((value >> 5) & 63) * 255 / 63);
                rgba[i * 4 + 2] = (uint8_t)((value & 31) * 255 / 31); rgba[i * 4 + 3] = 255;
                break;
            }
            case FORMAT_B5G5R5A1: {
                uint16_t value = (uint16_t)(source[i * 2] | (source[i * 2 + 1] << 8));
                rgba[i * 4] = (uint8_t)(((value >> 10) & 31) * 255 / 31);
                rgba[i * 4 + 1] = (uint8_t)(((value >> 5) & 31) * 255 / 31);
                rgba[i * 4 + 2] = (uint8_t)((value & 31) * 255 / 31);
                rgba[i * 4 + 3] = (value & 0x8000) ? 255 : 0;
                break;
            }
            default: return false;
        }
    }
    return true;
}

static void gather_block(const uint8_t *rgba, int width, int height, int bx, int by, uint8_t *block) {
    for (int py = 0; py < 4; py++) {
        int y = std::min(height - 1, by * 4 + py);
        for (int px = 0; px < 4; px++) {
            int x = std::min(width - 1, bx * 4 + px);
            memcpy(block + (py * 4 + px) * 4, rgba + ((size_t)y * width + x) * 4, 4);
        }
    }
}

static void encode_bc2_alpha(const uint8_t *pixels, uint8_t *target) {
    for (int py = 0; py < 4; py++) {
        uint16_t row = 0;
        for (int px = 0; px < 4; px++) row |= (uint16_t)(pixels[(py * 4 + px) * 4 + 3] >> 4) << (px * 4);
        target[py * 2] = (uint8_t)row;
        target[py * 2 + 1] = (uint8_t)(row >> 8);
    }
}

static bool encode_level(const uint8_t *rgba, int width, int height, int format,
                         int quality, uint8_t *target) {
    if (is_block_format(format)) {
        int bw = std::max(1, (width + 3) / 4);
        int bh = std::max(1, (height + 3) / 4);
        int bytes = block_bytes(format);
        int rgb_quality = quality <= 0 ? 8 : (quality == 1 ? 12 : (int)rgbcx::MAX_LEVEL);
        bc7enc_compress_block_params bc7_params;
        bc7enc_compress_block_params_init(&bc7_params);
        bc7_params.m_max_partitions = quality <= 0 ? 8 : (quality == 1 ? 32 : 64);
        bc7_params.m_uber_level = quality <= 0 ? 0 : (quality == 1 ? 1 : 2);
        for (int by = 0; by < bh; by++) {
            for (int bx = 0; bx < bw; bx++) {
                uint8_t pixels[64];
                gather_block(rgba, width, height, bx, by, pixels);
                uint8_t *block = target + ((size_t)by * bw + bx) * bytes;
                switch (format) {
                    case FORMAT_BC1: rgbcx::encode_bc1(rgb_quality, block, pixels, true, false); break;
                    case FORMAT_BC2:
                        encode_bc2_alpha(pixels, block);
                        rgbcx::encode_bc1(rgb_quality, block + 8, pixels, false, false);
                        break;
                    case FORMAT_BC3:
                        if (quality > 0) rgbcx::encode_bc3_hq(rgb_quality, block, pixels);
                        else rgbcx::encode_bc3(rgb_quality, block, pixels);
                        break;
                    case FORMAT_BC4:
                        if (quality > 0) rgbcx::encode_bc4_hq(block, pixels);
                        else rgbcx::encode_bc4(block, pixels);
                        break;
                    case FORMAT_BC5:
                        if (quality > 0) rgbcx::encode_bc5_hq(block, pixels);
                        else rgbcx::encode_bc5(block, pixels);
                        break;
                    case FORMAT_BC7: if (!bc7enc_compress_block(block, pixels, &bc7_params)) return false; break;
                    default: return false;
                }
            }
        }
        return true;
    }

    size_t count = (size_t)width * height;
    for (size_t i = 0; i < count; i++) {
        switch (format) {
            case FORMAT_BGRA8:
                target[i * 4] = rgba[i * 4 + 2]; target[i * 4 + 1] = rgba[i * 4 + 1];
                target[i * 4 + 2] = rgba[i * 4]; target[i * 4 + 3] = rgba[i * 4 + 3];
                break;
            case FORMAT_RGBA8: memcpy(target + i * 4, rgba + i * 4, 4); break;
            case FORMAT_A8: target[i] = rgba[i * 4 + 3]; break;
            case FORMAT_R8: target[i] = rgba[i * 4]; break;
            case FORMAT_B5G6R5: {
                uint16_t value = (uint16_t)(((rgba[i * 4] * 31 / 255) << 11) |
                    ((rgba[i * 4 + 1] * 63 / 255) << 5) | (rgba[i * 4 + 2] * 31 / 255));
                target[i * 2] = (uint8_t)value; target[i * 2 + 1] = (uint8_t)(value >> 8); break;
            }
            case FORMAT_B5G5R5A1: {
                uint16_t value = (uint16_t)(((rgba[i * 4 + 3] >= 128 ? 1 : 0) << 15) |
                    ((rgba[i * 4] * 31 / 255) << 10) | ((rgba[i * 4 + 1] * 31 / 255) << 5) |
                    (rgba[i * 4 + 2] * 31 / 255));
                target[i * 2] = (uint8_t)value; target[i * 2 + 1] = (uint8_t)(value >> 8); break;
            }
            default: return false;
        }
    }
    return true;
}

static uint8_t *resize_rgba(const uint8_t *rgba, int source_width, int source_height,
                            int target_width, int target_height) {
    uint8_t *output = (uint8_t *)malloc((size_t)target_width * target_height * 4);
    if (!output) return nullptr;
    STBIR_RESIZE resize;
    stbir_resize_init(&resize, rgba, source_width, source_height, 0,
                      output, target_width, target_height, 0, STBIR_RGBA, STBIR_TYPE_UINT8_SRGB);
    stbir_set_filters(&resize, STBIR_FILTER_MITCHELL, STBIR_FILTER_MITCHELL);
    if (!stbir_resize_extended(&resize)) { free(output); return nullptr; }
    return output;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE void eo_release_output() {
    free(g_output); g_output = nullptr; g_output_size = 0;
}

EMSCRIPTEN_KEEPALIVE uintptr_t eo_optimize_texture(const uint8_t *source, size_t source_size,
    int width, int height, int format, int max_dimension, int max_mips, int quality) {
    initialize_codec();
    eo_release_output();
    g_last_error = 0;
    if (!source || width <= 0 || height <= 0 || format < FORMAT_BC1 || format > FORMAT_B5G5R5A1) {
        g_last_error = 1; return 0;
    }
    int target_width = width, target_height = height;
    while (target_width > max_dimension || target_height > max_dimension) {
        target_width = std::max(1, target_width / 2);
        target_height = std::max(1, target_height / 2);
    }
    uint8_t *base = (uint8_t *)malloc((size_t)width * height * 4);
    if (!base) { g_last_error = 2; return 0; }
    if (!decode_base(source, source_size, width, height, format, base)) {
        free(base); g_last_error = 3; return 0;
    }
    uint8_t *target_base = base;
    if (target_width != width || target_height != height) {
        target_base = resize_rgba(base, width, height, target_width, target_height);
        free(base);
        if (!target_base) { g_last_error = 4; return 0; }
    }

    int mip_count = 1, mw = target_width, mh = target_height;
    size_t total = level_size(mw, mh, format);
    while ((mw > 1 || mh > 1) && mip_count < max_mips) {
        mw = std::max(1, mw / 2); mh = std::max(1, mh / 2);
        total += level_size(mw, mh, format); mip_count++;
    }
    g_output = (uint8_t *)malloc(total);
    if (!g_output) { free(target_base); g_last_error = 5; return 0; }
    size_t cursor = 0;
    mw = target_width; mh = target_height;
    for (int mip = 0; mip < mip_count; mip++) {
        uint8_t *pixels = target_base;
        if (mip > 0) {
            pixels = resize_rgba(target_base, target_width, target_height, mw, mh);
            if (!pixels) { free(target_base); eo_release_output(); g_last_error = 6; return 0; }
        }
        if (!encode_level(pixels, mw, mh, format, quality, g_output + cursor)) {
            if (mip > 0) free(pixels);
            free(target_base); eo_release_output(); g_last_error = 7; return 0;
        }
        cursor += level_size(mw, mh, format);
        if (mip > 0) free(pixels);
        mw = std::max(1, mw / 2); mh = std::max(1, mh / 2);
    }
    free(target_base);
    g_output_size = cursor;
    g_output_width = target_width; g_output_height = target_height;
    g_output_mips = mip_count; g_output_stride = row_pitch(target_width, format);
    return (uintptr_t)g_output;
}

EMSCRIPTEN_KEEPALIVE size_t eo_last_size() { return g_output_size; }
EMSCRIPTEN_KEEPALIVE int eo_last_width() { return g_output_width; }
EMSCRIPTEN_KEEPALIVE int eo_last_height() { return g_output_height; }
EMSCRIPTEN_KEEPALIVE int eo_last_mips() { return g_output_mips; }
EMSCRIPTEN_KEEPALIVE int eo_last_stride() { return g_output_stride; }
EMSCRIPTEN_KEEPALIVE int eo_last_error() { return g_last_error; }

}
