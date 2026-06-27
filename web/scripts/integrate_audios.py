#!/usr/bin/env python3
"""Integra os sons da pasta [AUDIOS] ao resource + catalogo, sem duplicar.

Estrutura da fonte: [AUDIOS]/<resource>/audioconfig/*.rel  e  <resource>/sfx/dlc_<hash>/*.awc
Um <resource> pode conter varios dlc (varios hashes).

Para cada hash novo (nao presente no catalog.json):
  - copia audioconfig/<hash>_*.rel (game/sounds e amp se existir)
  - copia sfx/dlc_<hash>/ (.awc), ignorando .nametable
  - acrescenta as linhas data_file ao fxmanifest.lua (na raiz)
  - adiciona a entrada no web/data/catalog.json (nome + motor inferido)
"""
import json
import os
import re
import shutil
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SRC = REPO.parent / "[AUDIOS]"
RES_AUDIO = REPO / "resource" / "audio"
FXM = REPO / "resource" / "fxmanifest.lua"
CAT = REPO / "web" / "data" / "catalog.json"

# nomes legiveis para hashes reconheciveis; o resto fica com o proprio hash
NAMES = {
    "s54b32": "BMW S54 3.2 I6", "s65b40": "BMW S65 4.0 V8",
    "aq77bmws85": "BMW S85 5.0 V10", "aq45bmws14b23": "BMW S14 2.3 I4",
    "kc31m3gtr": "BMW M3 GTR P60 V8", "aston59v12": "Aston Martin 5.9 V12",
    "m840trsenna": "McLaren Senna M840TR V8", "porsche57v10": "Porsche Carrera GT V10",
    "strcarreragt": "Porsche Carrera GT V10", "tagt3flat6": "Porsche GT3 Flat-6",
    "fordvoodoo": "Ford Voodoo 5.2 V8 (GT350)", "ecoboostv6": "Ford EcoBoost V6",
    "flatheadv8": "Ford Flathead V8", "ta008mustang69": "Ford Mustang 69 V8",
    "cvpiv8": "Crown Victoria Police V8", "cammedcharger": "Dodge Charger Cammed V8",
    "dodgehemihellcat": "Dodge Hemi Hellcat V8", "cummins5924v": "Cummins 5.9 24v Diesel I6",
    "aq09mazbpze": "Mazda BP-ZE I4", "aq31maz13btune": "Mazda 13B Rotary (tune)",
    "aq22honb18c": "Honda B18C I4", "aq32hond16z6": "Honda D16Z6 I4",
    "ta062k20a": "Honda K20A I4", "kc236f20c": "Honda F20C I4",
    "kc220k20decat": "Honda K20 (decat) I4", "aq57mit4g63t": "Mitsubishi 4G63T I4",
    "ta011mit4g63": "Mitsubishi 4G63 I4", "aq26mit4b11t": "Mitsubishi 4B11T I4",
    "ta4b11": "Mitsubishi 4B11 I4", "ta013vq35": "Nissan VQ35 V6",
    "kc238vq38ttst": "Nissan VQ38 TT V6", "kc153rb20det": "Nissan RB20DET I6",
    "kc153rb20neo": "Nissan RB20 NEO I6", "strsr20": "Nissan SR20 I4",
    "aq03ej257": "Subaru EJ257 F4", "aq05ej257el": "Subaru EJ257 F4 (alt)",
    "aq34lot18vhpd": "Lotus 1.8 VHPD I4", "aq36hyutheta2n": "Hyundai Theta 2 I4",
    "aq48roln72v12": "Rolls-Royce L72 V12", "ta023l539": "Lamborghini L539 V12",
    "ta122s58": "BMW S58 I6", "kc233m3s58ds": "BMW M3 S58 I6",
    "kc228m5s63t": "BMW M5 S63 V8", "ta488f154": "Ferrari F154 V8",
    "taaud40v8": "Audi 4.0 V8", "audiea855": "Audi EA855 V8",
    "audi7a": "Audi 7A I5", "audiwx": "Audi WX I5", "v6audiea839": "Audi EA839 V6",
    "vwflat4": "VW Flat-4", "alfa690t": "Alfa Romeo 690T V6",
    "ars7": "Audi RS7 V8", "lancernovo": "Mitsubishi Lancer",
    "str20gdi": "Hyundai 2.0 GDI I4", "strar4c": "Honda AR4C",
    "aq11bmw298cc": "BMW 298cc", "kc135bm36": "BMW M3.6 I6",
}

ENGINE_PATTERNS = [
    (r"\bW16\b|w16", "W16"), (r"\bV12\b|v12|l539|l72", "V12"),
    (r"\bV10\b|v10|s85|lfa", "V10"), (r"\bV8\b|v8|s63|s65|voodoo|hemi|hellcat", "V8"),
    (r"\bV6\b|v6|vq3|ea839|690t", "V6"),
    (r"\bI6\b|i6|s54|s58|rb2|b58|n55|cummins|m36|bm36", "I6"),
    (r"\bI4\b|i4|4g63|4b11|b18|d16|k20|f20c|sr20|ej257|f4\b|theta|bpze|s14", "I4"),
    (r"\bI5\b|audi7a|audiwx|5cyl", "I5"),
    (r"rotor|rotary|13b", "Rotary"),
    (r"diesel|cummins|detroit|duramax|6cil|d60", "Diesel"),
    (r"flat-?6|flat6|gt3flat|boxer", "F6"),
    (r"flat-?4|vwflat|ej257|f4\b", "F4"),
    (r"mustang|gsxr|titan|cbx|cbr|yamaha|r1\b|duke|ducati|mt09|moto", "Moto"),
]


def infer_engine(text):
    for pat, label in ENGINE_PATTERNS:
        if re.search(pat, text, re.IGNORECASE):
            return label
    return "Other"


def main():
    cat = json.loads(CAT.read_text(encoding="utf-8"))
    existing = {s["hash"].lower() for s in cat}

    # mapeia hash -> (audioconfig_dir, sfx_dlc_dir)
    chosen = {}
    for res in sorted(os.listdir(SRC)):
        rdir = SRC / res
        sfx = rdir / "sfx"
        ac = rdir / "audioconfig"
        if not sfx.is_dir():
            continue
        for d in sorted(os.listdir(sfx)):
            if not d.startswith("dlc_"):
                continue
            h = d[4:]
            if h.lower() in existing or h in chosen:
                continue
            chosen[h] = (ac, sfx / d)

    fxlines = ["\n-- ==== Sons da pasta [AUDIOS] ====\n"]
    added = skipped = 0
    for h, (ac, dlcdir) in sorted(chosen.items()):
        game = ac / f"{h}_game.dat151.rel"
        sounds = ac / f"{h}_sounds.dat54.rel"
        amp = ac / f"{h}_amp.dat10.rel"
        if not (game.exists() and sounds.exists() and dlcdir.is_dir()):
            print(f"  PULADO (faltam arquivos): {h}")
            skipped += 1
            continue
        
        # Create folder for engine
        engine_dir = RES_AUDIO / h
        engine_dir.mkdir(parents=True, exist_ok=True)
        
        shutil.copy2(game, engine_dir / game.name)
        shutil.copy2(sounds, engine_dir / sounds.name)
        has_amp = amp.exists()
        if has_amp:
            shutil.copy2(amp, engine_dir / amp.name)
        dst = engine_dir / f"dlc_{h}"
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(dlcdir, dst, ignore=shutil.ignore_patterns("*.nametable"))
        name = NAMES.get(h, h)
        fxlines.append(f"-- {name} --")
        if has_amp:
            fxlines.append(f"data_file 'AUDIO_SYNTHDATA' 'audio/{h}/{h}_amp.dat'")
        fxlines.append(f"data_file 'AUDIO_GAMEDATA' 'audio/{h}/{h}_game.dat'")
        fxlines.append(f"data_file 'AUDIO_SOUNDDATA' 'audio/{h}/{h}_sounds.dat'")
        fxlines.append(f"data_file 'AUDIO_WAVEPACK' 'audio/{h}/dlc_{h}'\n")
        cat.append({
            "name": name, "hash": h, "image": "",
            "author": "", "sourceUrl": "",
            "engine": infer_engine(name + " " + h),
        })
        added += 1

    with open(FXM, "a", encoding="utf-8") as f:
        f.write("\n".join(fxlines) + "\n")
    cat.sort(key=lambda r: r["name"].lower())
    CAT.write_text(json.dumps(cat, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nAdicionados {added} | pulados {skipped} | catalogo agora {len(cat)}")


if __name__ == "__main__":
    main()
