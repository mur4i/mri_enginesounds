#!/usr/bin/env python3
"""Gera data/catalog.json a partir do README.md do FiveM-Engine-Sound-Pack.

Le a tabela markdown (Sound Mod | audioNameHash | Picture | Author | Link | Status)
e produz uma lista estruturada de sons. Tambem tenta inferir o tipo de motor
(V8, V10, V12, I4, I6, F6, rotary, etc.) a partir do nome.
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # web/scripts/ -> raiz do repo
# o repo vive em resources/[VEHICLE AUDIO]/ — o pack fonte fica ao lado
SRC = ROOT.parent / "FiveM-Engine-Sound-Pack" / "README.md"

ENGINE_PATTERNS = [
    (r"\bW16\b", "W16"),
    (r"\bV12\b", "V12"),
    (r"\bV10\b", "V10"),
    (r"\bV8\b", "V8"),
    (r"\bV6\b", "V6"),
    (r"\bI6\b", "I6"),
    (r"\bI4\b", "I4"),
    (r"\bI3\b", "I3"),
    (r"\bI1\b", "I1"),
    (r"\bF6\b|Flat-6|Flat 6", "F6"),
    (r"\bF4\b", "F4"),
    (r"rotor|rotary|13B|20B|26B|Renesis|REW", "Rotary"),
]


def infer_engine(name):
    for pat, label in ENGINE_PATTERNS:
        if re.search(pat, name, re.IGNORECASE):
            return label
    return "Other"


def parse():
    text = SRC.read_text(encoding="utf-8")
    rows = []
    for line in text.splitlines():
        line = line.strip()
        # linhas de dados da tabela começam com | ** (nome em negrito)
        if not line.startswith("| **"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 5:
            continue
        name = cells[0].strip("* ").strip()
        audio_hash = cells[1].strip()
        # extrai o nome do arquivo de imagem
        pic = ""
        m = re.search(r"\(([^)]+\.webp)\)", cells[2])
        if m:
            pic = Path(m.group(1)).name
        author = cells[3].strip()
        # extrai a URL do link do autor
        link = ""
        m = re.search(r"\((https?://[^)]+)\)", cells[4])
        if m:
            link = m.group(1)
        rows.append({
            "name": name,
            "hash": audio_hash,
            "image": pic,
            "author": author,
            "sourceUrl": link,
            "engine": infer_engine(name),
        })
    return rows


def main():
    rows = parse()
    # ordena por nome
    rows.sort(key=lambda r: r["name"].lower())
    out = ROOT / "web" / "data" / "catalog.json"
    out.write_text(json.dumps(rows, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"{len(rows)} sons escritos em {out}")
    # resumo por tipo de motor
    from collections import Counter
    c = Counter(r["engine"] for r in rows)
    print("Tipos:", dict(c.most_common()))


if __name__ == "__main__":
    main()
