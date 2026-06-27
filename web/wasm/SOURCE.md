# EasyOptimizer-V WebAssembly texture module

This directory contains the corresponding wrapper source and reproducible build
instructions for the texture codec distributed with MRI Engine Sounds.

The texture optimization pipeline is derived from
[EasyOptimizer-V](https://github.com/LN-Development/EasyOptimizer-V) at commit
`223d5792fbeb81c8f9ed9fdadad0f7f961a95778`. EasyOptimizer-V is copyright its
contributors and licensed under GNU GPL version 3.

The build uses EasyOptimizer-V's copies of `rgbcx`, `bc7enc`, `bc7decomp` and
`stb_image_resize2`. Their own permissive license notices remain in the pinned
upstream source. The MRI wrapper in `src/eo_texture_wasm.cpp` is distributed
under GPL-3.0-only.

To reproduce the browser artifacts, start Docker Desktop and run:

```powershell
./web/wasm/build.ps1
```

The script checks out the exact upstream revision and builds with the pinned
Emscripten SDK image. The resulting JavaScript and WebAssembly files are written
to `web/assets/`.
