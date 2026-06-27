#!/usr/bin/env python3
"""Converte os .awc do FiveM-Engine-Sound-Pack em previews .ogg para o site.

Requer vgmstream-cli (https://github.com/vgmstream/vgmstream/releases) e ffmpeg.
Uso:
    python web/scripts/convert_previews.py --vgmstream "C:/caminho/vgmstream-cli.exe"

Para cada som do catalogo:
  1. vgmstream-cli decodifica sfx/dlc_<hash>/<hash>.awc -> wav temporario
     (usa o sub-stream mais longo, que costuma ser a amostra de aceleracao)
  2. ffmpeg corta os primeiros N segundos e exporta ogg para previews/<hash>.ogg
"""
import argparse
import json
import re
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # web/scripts/ -> raiz do repo
# .awc originais versionados na raiz do repo (que tambem e o resource FiveM)
DEFAULT_SFX = ROOT / "resource" / "audio"
PREVIEWS = ROOT / "web" / "previews"  # site fica em web/
MAX_SECONDS = 12  # duracao maxima do preview


def stream_count(vgm, awc):
    """Retorna quantos sub-streams o .awc tem (via -m metadata)."""
    out = subprocess.run([vgm, "-m", str(awc)], capture_output=True, text=True)
    m = re.search(r"stream count:\s*(\d+)", out.stdout)
    return int(m.group(1)) if m else 1


def pick_and_convert(vgm, ffmpeg, awc, dst):
    n = stream_count(vgm, awc)
    best = None  # (size, path)
    with tempfile.TemporaryDirectory() as td:
        for i in range(1, n + 1):
            wav = Path(td) / f"s{i}.wav"
            r = subprocess.run(
                [vgm, "-s", str(i), "-o", str(wav), str(awc)],
                capture_output=True, text=True,
            )
            if wav.exists() and wav.stat().st_size > 0:
                sz = wav.stat().st_size
                if best is None or sz > best[0]:
                    best = (sz, wav.read_bytes())
        if best is None:
            return False
        src_wav = Path(td) / "best.wav"
        src_wav.write_bytes(best[1])
        subprocess.run(
            [ffmpeg, "-y", "-i", str(src_wav), "-t", str(MAX_SECONDS),
             "-ac", "2", "-q:a", "5", str(dst)],
            capture_output=True,
        )
    return dst.exists()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vgmstream", required=True, help="caminho do vgmstream-cli")
    ap.add_argument("--ffmpeg", default="ffmpeg", help="caminho do ffmpeg")
    ap.add_argument("--sfx", default=str(DEFAULT_SFX),
                    help="pasta sfx com dlc_<hash>/<hash>.awc")
    args = ap.parse_args()
    sfx = Path(args.sfx)

    PREVIEWS.mkdir(exist_ok=True)
    cat = json.loads((ROOT / "web" / "data" / "catalog.json").read_text(encoding="utf-8"))
    ok = fail = skip = 0
    for s in cat:
        h = s["hash"]
        dst = PREVIEWS / f"{h}.ogg"
        if dst.exists():
            skip += 1
            continue
        awc = sfx / h / f"dlc_{h}" / f"{h}.awc"
        if not awc.exists():
            print(f"  sem .awc: {h}")
            fail += 1
            continue
        if pick_and_convert(args.vgmstream, args.ffmpeg, awc, dst):
            ok += 1
            print(f"  ok: {h}")
        else:
            fail += 1
            print(f"  falha: {h}")
    print(f"\nConcluido. ok={ok} falha={fail} pulados={skip}")


if __name__ == "__main__":
    main()
