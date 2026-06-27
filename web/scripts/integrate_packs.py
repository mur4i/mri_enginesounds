#!/usr/bin/env python3
"""Integra sons dos outros packs (na raiz do repo/resource) e ao catalogo, sem duplicar.

Fontes: mri_mechanic_engines, Realidade_Vehsounds, aq66audea855.
Para cada hash novo (nao presente no catalog.json):
  - copia audioconfig/<hash>_{game.dat151,sounds.dat54,amp.dat10}.rel (amp se existir)
  - copia sfx/dlc_<hash>/ (.awc)
  - acrescenta as linhas data_file ao fxmanifest.lua
  - adiciona a entrada no data/catalog.json (nome legivel + motor inferido)
"""
import json
import os
import re
import shutil
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]  # web/scripts/ -> raiz do repo
# o repo vive dentro de resources/[VEHICLE AUDIO]/ (clone ao lado dos packs fonte)
SRCBASE = REPO.parent
RES_AUDIO = REPO / "resource" / "audio"
FXM = REPO / "resource" / "fxmanifest.lua"
CAT = REPO / "web" / "data" / "catalog.json"

# ordem de prioridade: se o mesmo hash existir em 2 packs, usa o primeiro
PACKS = [
    ("mri_mechanic_engines", SRCBASE / "mri_mechanic_engines" / "data"),
    ("Realidade_Vehsounds", SRCBASE / "Realidade_Vehsounds"),
    ("aq66audea855", SRCBASE / "aq66audea855"),
]

# nomes legiveis para hashes reconheciveis (o resto vira o hash prettificado)
NAMES = {
    "488sound": "Ferrari 488 GTB V8", "agerasound": "Koenigsegg Agera V8",
    "apollosv8": "Apollo IE V8", "avesv": "Lamborghini Aventador SV V12",
    "avesvv12": "Lamborghini Aventador SVJ V12", "b58b30": "BMW B58 3.0 I6",
    "c6v8sound": "Chevrolet Corvette C6 V8", "chevroletlt4": "Chevrolet LT4 V8",
    "diablov12": "Lamborghini Diablo V12", "ea825": "Audi EA825 4.0 V8",
    "ea888": "VW/Audi EA888 2.0 I4", "elegyx": "Elegy X (R35)",
    "evoixsound": "Mitsubishi Lancer Evo IX I4", "f40v8": "Ferrari F40 V8",
    "f430v8": "Ferrari F430 V8", "f50v12": "Ferrari F50 V12",
    "ferrarif12": "Ferrari F12 V12", "ferrarif154": "Ferrari F154 V8 (296/SF90)",
    "gallardov10": "Lamborghini Gallardo V10", "gtaspanov10": "Spano V10",
    "harleyvtwin": "Harley-Davidson V-Twin", "hellcatsound": "Dodge Hellcat V8",
    "k20c": "Honda K20C 2.0 I4", "kc12r1200gsakrapovic": "BMW R1200GS Akrapovic",
    "kc23titan160diretao": "Honda Titan 160 (Diretao)",
    "kc23titan160dore": "Honda Titan 160 (Dore)",
    "kc23titan160polimet": "Honda Titan 160 (Polimet)",
    "kc26golft": "VW Golf GTI Turbo", "kc32ducavr4": "Ducati Panigale V4",
    "kc73pgt3rsakrapovic": "Porsche GT3 RS Akrapovic",
    "kc74s1000rrakevoline": "BMW S1000RR Akrapovic",
    "ktm1290r": "KTM 1290 Super Duke R", "laferrarisound": "Ferrari LaFerrari V12",
    "lfasound": "Lexus LFA V10", "m5cracklemod": "BMW M5 V8 (Crackle)",
    "mazrx7fb": "Mazda RX-7 FB Rotary", "mclarenv8": "McLaren V8",
    "mercedesm113": "Mercedes M113 V8", "mercedesm155": "Mercedes M155 V8",
    "mercm177": "Mercedes-AMG M177 4.0 V8", "mercm279": "Mercedes M279 6.0 V12",
    "murciev12": "Lamborghini Murcielago V12", "n55b30t0": "BMW N55 3.0 I6",
    "novitecsvj": "Novitec Aventador SVJ V12", "p60b40": "BMW M3 GTR P60B40 V8",
    "perfov10": "Lamborghini Performante V10", "porschema2": "Porsche MA2 V8",
    "r35sound": "Nissan GT-R R35 V6", "s15sound": "Nissan Silvia S15 I4",
    "s55b30": "BMW S55 3.0 I6", "s63b44": "BMW S63 4.4 V8",
    "s85b50": "BMW S85 5.0 V10", "s85b50b": "BMW S85 5.0 V10 (alt)",
    "sestov10": "Lamborghini Sesto Elemento V10", "shonen": "Shonen",
    "str2cbx400fsp": "Honda CBX 400 (SP)", "strcbr400f": "Honda CBR 400F",
    "suzukigsxr1k": "Suzuki GSX-R 1000", "tacumminsb": "Cummins Diesel I6",
    "tayamahar1": "Yamaha YZF-R1", "twinhuracan": "Lamborghini Huracan TT V10",
    "urusv8": "Lamborghini Urus 4.0 V8", "veyronsound": "Bugatti Veyron W16",
    "viperv10": "Dodge Viper V10", "vr38dettv6": "Nissan VR38DETT V6",
    "aq66audea855": "Audi (aq66 custom)",
}

ENGINE_PATTERNS = [
    (r"\bW16\b", "W16"), (r"\bV12\b", "V12"), (r"\bV10\b", "V10"),
    (r"\bV8\b", "V8"), (r"\bV6\b", "V6"), (r"\bI6\b", "I6"),
    (r"\bI4\b", "I4"), (r"\bI3\b", "I3"), (r"\bI1\b", "I1"),
    (r"\bF6\b|Flat-6", "F6"), (r"\bF4\b", "F4"),
    (r"rotor|rotary|13B|RX-?7|RX-?8", "Rotary"),
    (r"diesel|cummins|duramax", "Diesel"),
    (r"\bR1\b|R1200|S1000RR|GSX|Duke|Ducati|Panigale|CBX|CBR|V-?Twin|Yamaha|Suzuki|KTM|Harley|Titan", "Moto"),
]


def infer_engine(name):
    for pat, label in ENGINE_PATTERNS:
        if re.search(pat, name, re.IGNORECASE):
            return label
    return "Other"


def prettify(h):
    return NAMES.get(h, h)


def main():
    cat = json.loads(CAT.read_text(encoding="utf-8"))
    existing = {s["hash"].lower() for s in cat}

    chosen = {}  # hash -> (pack_label, pack_path)
    for label, root in PACKS:
        sfx = root / "sfx"
        if not sfx.is_dir():
            continue
        for d in sorted(os.listdir(sfx)):
            if not d.startswith("dlc_"):
                continue
            h = d[4:]
            if h.lower() in existing or h in chosen:
                continue
            chosen[h] = (label, root)

    fxlines = ["\n-- ==== Sons adicionados de outros packs (MRI) ====\n"]
    added = 0
    for h, (label, root) in sorted(chosen.items()):
        ac = root / "audioconfig"
        game = ac / f"{h}_game.dat151.rel"
        sounds = ac / f"{h}_sounds.dat54.rel"
        amp = ac / f"{h}_amp.dat10.rel"
        srcsfx = root / "sfx" / f"dlc_{h}"
        if not (game.exists() and sounds.exists() and srcsfx.is_dir()):
            print(f"  PULADO (faltam arquivos): {h}")
            continue
        
        # Create folder for engine
        engine_dir = RES_AUDIO / h
        engine_dir.mkdir(parents=True, exist_ok=True)
        
        # copia audioconfig
        shutil.copy2(game, engine_dir / game.name)
        shutil.copy2(sounds, engine_dir / sounds.name)
        has_amp = amp.exists()
        if has_amp:
            shutil.copy2(amp, engine_dir / amp.name)
        # copia sfx
        dst = engine_dir / f"dlc_{h}"
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(srcsfx, dst, ignore=shutil.ignore_patterns("*.nametable"))
        # linhas do manifesto
        fxlines.append(f"-- {prettify(h)} --")
        if has_amp:
            fxlines.append(f"data_file 'AUDIO_SYNTHDATA' 'audio/{h}/{h}_amp.dat'")
        fxlines.append(f"data_file 'AUDIO_GAMEDATA' 'audio/{h}/{h}_game.dat'")
        fxlines.append(f"data_file 'AUDIO_SOUNDDATA' 'audio/{h}/{h}_sounds.dat'")
        fxlines.append(f"data_file 'AUDIO_WAVEPACK' 'audio/{h}/dlc_{h}'\n")
        # entrada do catalogo
        name = prettify(h)
        cat.append({
            "name": name,
            "hash": h,
            "image": "",
            "author": "",
            "sourceUrl": "",
            "engine": infer_engine(name + " " + h),
        })
        added += 1

    # grava fxmanifest (append)
    with open(FXM, "a", encoding="utf-8") as f:
        f.write("\n".join(fxlines) + "\n")
    # grava catalogo ordenado
    cat.sort(key=lambda r: r["name"].lower())
    CAT.write_text(json.dumps(cat, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nAdicionados {added} sons. Catalogo agora: {len(cat)}.")
    from collections import Counter
    print("Por pack:", dict(Counter(s.get('pack','?') for s in cat)))


if __name__ == "__main__":
    main()
