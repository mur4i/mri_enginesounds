#!/usr/bin/env python3
"""Busca imagens automaticas (DuckDuckGo) para os sons sem capa.

Para cada som alvo:
  - monta uma query a partir do nome (carro = paisagem)
  - escolhe a melhor candidata do DuckDuckGo PRIORIZANDO imagens em paisagem
    (w >= h) e largura >= 600 -> evita retratos fora de assunto
  - baixa e converte para web/images/<hash>.webp (ffmpeg)
  - seta catalog["image"] = "<hash>.webp"

Modos:
  python web/scripts/fetch_images.py                 # so quem NAO tem imagem
  python web/scripts/fetch_images.py --portrait      # re-busca imagens atuais em retrato (suspeitas)
  python web/scripts/fetch_images.py --only f40v8,k20a   # hashes especificos (re-busca)
  python web/scripts/fetch_images.py --force         # re-busca TODOS
  python web/scripts/fetch_images.py --limit 10      # teste
"""
import argparse
import json
import re
import ssl
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

from ddgs import DDGS

REPO = Path(__file__).resolve().parents[2]
IMAGES = REPO / "web" / "images"
CAT = REPO / "web" / "data" / "catalog.json"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
MIN_W = 600


def ddg_candidates(query, n=12):
    """Devolve URLs ranqueadas: paisagem grande primeiro, retrato por ultimo."""
    try:
        # safesearch estrito: nunca trazer conteudo adulto
        results = list(DDGS().images(query, max_results=n, safesearch="on"))
    except Exception:
        return []
    good, meh, bad = [], [], []
    for r in results:
        img = r.get("image")
        if not img:
            continue
        try:
            w, h = int(r.get("width") or 0), int(r.get("height") or 0)
        except (TypeError, ValueError):
            w = h = 0
        is_img = bool(re.search(r"\.(jpe?g|png|webp)(\?|$)", img, re.I))
        if w and h:
            ratio = w / h
            if ratio >= 1.15 and w >= MIN_W:      # paisagem boa
                (good if is_img else meh).append(img)
            elif ratio >= 0.95:                    # quadrada-ish, aceitavel
                meh.append(img)
            else:                                  # retrato -> evitar
                bad.append(img)
        else:
            meh.append(img)
    return good + meh + bad


def _has(v):
    return v and v != "Desconhecido"


def is_unsearchable(sound):
    """Sem marca/modelo E com nome = hash/codigo -> query inutil, NAO buscar."""
    if _has(sound.get("brand")) and _has(sound.get("model")):
        return False  # da pra buscar por marca+modelo
    name = sound["name"].strip()
    if name.lower() == sound["hash"].lower():
        return True
    if " " not in name and re.match(r"^[a-z]+\d", name.lower()):
        return True
    return False


def query_for(sound):
    # prioriza "Marca Modelo" (mais preciso); senao usa o nome
    if _has(sound.get("brand")) and _has(sound.get("model")):
        base = f"{sound['brand']} {sound['model']}"
    else:
        base = re.sub(r"\([^)]*\)", "", sound["name"]).strip()
    base = re.sub(r"\([^)]*\)", "", base).strip()
    suffix = {"Moto": "motorcycle", "Caminhao": "truck"}.get(sound.get("vehicleType"), "car")
    return f"{base} {suffix}"


def img_size(path):
    """(w,h) de uma imagem local via ffprobe, ou (0,0)."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", str(path)],
            capture_output=True, text=True)
        w, h = out.stdout.strip().split("x")
        return int(w), int(h)
    except Exception:
        return 0, 0


def download_to_webp(img_url, dst):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with tempfile.TemporaryDirectory() as td:
        raw = Path(td) / "raw"
        req = urllib.request.Request(img_url, headers={**UA, "Referer": "https://duckduckgo.com/"})
        try:
            blob = urllib.request.urlopen(req, timeout=25, context=ctx).read()
        except Exception:
            return False
        if len(blob) < 1500:
            return False
        raw.write_bytes(blob)
        subprocess.run(
            ["ffmpeg", "-y", "-i", str(raw),
             "-vf", "scale='min(640,iw)':-2", "-frames:v", "1", str(dst)],
            capture_output=True)
        return dst.exists() and dst.stat().st_size > 0


def select_targets(cat, args):
    # --only ignora o filtro de criptico (override manual)
    if args.only:
        wanted = {x.strip().lower() for x in args.only.split(",") if x.strip()}
        return [s for s in cat if s["hash"].lower() in wanted]
    # nos demais modos, so buscar quem da pra pesquisar (marca+modelo ou nome real)
    named = [s for s in cat if not is_unsearchable(s)]
    if args.portrait:
        out = []
        for s in named:
            if not s.get("image"):
                continue
            p = IMAGES / s["image"]
            if not p.exists():
                continue
            w, h = img_size(p)
            if w and h and (w / h) < 1.15:
                out.append(s)
        return out
    if args.force:
        return named
    return [s for s in named if not s.get("image")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--delay", type=float, default=1.2)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--portrait", action="store_true")
    ap.add_argument("--only", default="")
    args = ap.parse_args()

    cat = json.loads(CAT.read_text(encoding="utf-8"))
    todo = select_targets(cat, args)
    if args.limit:
        todo = todo[:args.limit]
    print(f"alvos: {len(todo)}")

    IMAGES.mkdir(exist_ok=True)
    ok = fail = 0
    for i, s in enumerate(todo, 1):
        h = s["hash"]
        q = query_for(s)
        dst = IMAGES / f"{h}.webp"
        done = False
        try:
            for img in ddg_candidates(q)[:6]:
                if download_to_webp(img, dst):
                    s["image"] = f"{h}.webp"
                    ok += 1
                    done = True
                    print(f"  [{i}/{len(todo)}] OK {h}  <- {q}")
                    break
            if not done:
                print(f"  [{i}/{len(todo)}] -- sem candidata boa: {h} ({q})")
                fail += 1
        except Exception as e:
            print(f"  [{i}/{len(todo)}] -- erro {h}: {e}")
            fail += 1
        time.sleep(args.delay)

    CAT.write_text(json.dumps(cat, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nConcluido. ok: {ok} | falhas: {fail}")
    print(f"catalogo com imagem: {sum(1 for s in cat if s.get('image'))}/{len(cat)}")


if __name__ == "__main__":
    main()
