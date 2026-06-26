#!/usr/bin/env python3
"""Mescla os metadados enriquecidos (do workflow) no catalog.json, por hash.

Entrada: web/data/_enrichment.json  -> { "records": [ {hash, brand, model, ...} ] }
Saida:   web/data/catalog.json (campos adicionados/atualizados)

Campos mesclados: brand, model, engineCode, displacement, layout, aspiration,
vehicleType, fuel, description, confidence.
"""
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CAT = REPO / "web" / "data" / "catalog.json"
ENR = REPO / "web" / "data" / "_enrichment.json"

FIELDS = ["brand", "model", "engineCode", "displacement", "layout",
          "aspiration", "vehicleType", "fuel", "description", "confidence"]


def main():
    cat = json.loads(CAT.read_text(encoding="utf-8"))
    data = json.loads(ENR.read_text(encoding="utf-8"))
    records = data.get("records", data if isinstance(data, list) else [])
    by_hash = {r["hash"]: r for r in records if r.get("hash")}

    merged = miss = 0
    for s in cat:
        r = by_hash.get(s["hash"])
        if not r:
            miss += 1
            continue
        for f in FIELDS:
            if r.get(f) not in (None, ""):
                s[f] = r[f]
        merged += 1

    CAT.write_text(json.dumps(cat, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"mesclados: {merged} | sem enriquecimento: {miss} | total: {len(cat)}")
    # resumo de cobertura
    for f in ("brand", "displacement", "aspiration", "vehicleType", "fuel"):
        n = sum(1 for s in cat if s.get(f) and s[f] != "Desconhecido")
        print(f"  {f}: {n}/{len(cat)}")


if __name__ == "__main__":
    main()
