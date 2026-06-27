param(
  [string]$EasyOptimizerPath = "",
  [string]$Image = "emscripten/emsdk:4.0.10"
)

$ErrorActionPreference = "Stop"
$pinnedCommit = "223d5792fbeb81c8f9ed9fdadad0f7f961a95778"
$wasmRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$webRoot = Split-Path -Parent $wasmRoot

if (-not $EasyOptimizerPath) {
  $EasyOptimizerPath = Join-Path $env:TEMP "EasyOptimizer-V-wasm-source"
  if (-not (Test-Path -LiteralPath $EasyOptimizerPath)) {
    git clone https://github.com/LN-Development/EasyOptimizer-V.git $EasyOptimizerPath
  }
  git -C $EasyOptimizerPath fetch origin $pinnedCommit
  git -C $EasyOptimizerPath checkout --detach $pinnedCommit
}

$webMount = $webRoot.Replace("\", "/")
$easyMount = (Resolve-Path -LiteralPath $EasyOptimizerPath).Path.Replace("\", "/")

docker run --rm `
  -v "${webMount}:/work" `
  -v "${easyMount}:/easy:ro" `
  $Image `
  em++ /work/wasm/src/eo_texture_wasm.cpp `
    /easy/vendor/bc7enc_rdo/rgbcx.cpp `
    /easy/vendor/bc7enc_rdo/bc7enc.cpp `
    /easy/vendor/bc7enc_rdo/bc7decomp.cpp `
    -I/easy/vendor/bc7enc_rdo -I/easy/vendor/stb `
    -O3 -flto -msimd128 `
    -s MODULARIZE=1 -s EXPORT_NAME=createEOTextureCodec `
    -s ALLOW_MEMORY_GROWTH=1 -s FILESYSTEM=0 -s ENVIRONMENT=web,worker,node `
    -s ASSERTIONS=0 -s MALLOC=emmalloc `
    -s EXPORTED_RUNTIME_METHODS='["HEAPU8"]' `
    -s EXPORTED_FUNCTIONS='["_malloc","_free","_eo_optimize_texture","_eo_release_output","_eo_last_size","_eo_last_width","_eo_last_height","_eo_last_mips","_eo_last_stride","_eo_last_format","_eo_last_noop","_eo_last_error"]' `
    --extern-pre-js /work/wasm/src/license-pre.js `
    -o /work/assets/eo-texture-codec.js

if ($LASTEXITCODE -ne 0) { throw "Falha ao compilar o codec WebAssembly." }
Write-Host "Codec gerado em web/assets/eo-texture-codec.js e .wasm"
