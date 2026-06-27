# MRI Engine Sounds

Catálogo e **player web** dos sons de motor (engine sounds) usados no MRI para **FiveM**.
O site roda no **GitHub Pages**: dá pra buscar, filtrar por tipo de motor, ouvir o preview
e copiar o `audioNameHash` pra colar no `vehicles.meta` do veículo.

> 🌐 Site: `https://<usuario>.github.io/mri_enginesounds/` (ativado nas configurações de Pages)

## Como usar um som no carro

1. Encontre o som no site e copie o `audioNameHash` (clique nele).
2. Abra o `vehicles.meta` do veículo add-on e cole:
   ```xml
   <audioNameHash>lgcy01chargerv8</audioNameHash>
   ```

## Estrutura

O repositório guarda dois produtos: o resource FiveM em **`resource/`** e o
site estático em **`web/`**, publicado no GitHub Pages via workflow.

| Pasta / arquivo | O que é |
| --- | --- |
| `resource/fxmanifest.lua` | Manifesto do **resource FiveM** (declara os áudios). |
| `resource/audio/<hash>/` | Configs `.rel` e áudios `.awc` de cada som. |
| `resource/client.lua`, `resource/server.lua` | Scripts do resource (comando `/changesound`). |
| `web/index.html` | Página inicial do site. |
| `web/catalogo.html` | Catálogo, player e gerador de pacotes de som. |
| `web/otimizador.html` | Analisador/otimizador local de resources de veículos. |
| `web/assets/` | CSS e JavaScript do site, sem etapa de build. |
| `web/data/catalog.json` | Catálogo dos sons (nome, hash, tipo de motor, autor, fonte). |
| `web/images/` | Capas dos sons (`.webp`). |
| `web/previews/` | Previews de áudio tocáveis no navegador (`<hash>.ogg`). |
| `web/scripts/build_catalog.py` | Gera `web/data/catalog.json` a partir do README do pack de origem. |
| `web/scripts/convert_previews.py` | Converte os `.awc` de `resource/audio/` em previews `.ogg`. |
| `web/scripts/integrate_packs.py` | Mescla sons de outros packs ao resource + catálogo (sem duplicar). |

> **Pages:** publicado pelo workflow `Deploy site (Pages)` a partir de `web/`.
> Em *Settings → Pages → Source* deve estar **"GitHub Actions"**.

## Instalar no servidor FiveM

Pegue o `mri_enginesounds.zip` na aba **[Releases](https://github.com/mur4i/mri_enginesounds/releases)**:

1. Extraia a pasta `mri_enginesounds/` para o `resources/` do servidor.
2. Adicione `ensure mri_enginesounds` no `server.cfg`.

> O resource publicado é **limpo**: sem o `versioncheck.lua`/telemetria do pack original.

## Gerar um release

Crie uma tag de versão — o GitHub Actions empacota o resource (raiz) e publica o `.zip`:

```bash
git tag v1.0.0
git push origin v1.0.0
```

(ou rode **Actions → Release resource → Run** informando a tag manualmente.)

## Gerar / atualizar o catálogo

```bash
python web/scripts/build_catalog.py
```

> Esse script recria o catálogo a partir do pack de origem. Preserve/mescle os
> metadados enriquecidos antes de usá-lo sobre o catálogo publicado.

## Otimizador local de veículos

A página `web/otimizador.html` aceita um ZIP ou uma pasta de resource. A leitura,
a análise e a geração do novo ZIP acontecem no navegador com a File API e uma
cópia local do JSZip. Não existe endpoint de upload.

As correções automáticas são conservadoras: manifesto ausente/incompleto,
arquivos GTA fora de `stream/` e lixo temporário. O analisador abre o container
RSC7 de cada `.ytd` em um Web Worker e identifica resolução, formato BC/DXGI,
mipmaps, memória estimada e conteúdo duplicado. Os formatos compilados ainda
são preservados sem regravação; o encoder WebAssembly será a próxima etapa.

A leitura YTD foi implementada a partir do layout público RSC7 e validada contra
o comportamento do [EasyOptimizer-V](https://github.com/LN-Development/EasyOptimizer-V).
Veja o aviso técnico e de licença em `web/vendor/EASYOPTIMIZER-NOTICE.md`.

## Gerar os previews de áudio

Os arquivos originais são `.awc` (container RAGE do GTA-V) e **não tocam no navegador**.
É preciso convertê-los **uma vez** para `.ogg` com [vgmstream](https://github.com/vgmstream/vgmstream/releases) + ffmpeg:

```bash
python web/scripts/convert_previews.py --vgmstream "C:/tools/vgmstream-cli.exe"
```

Os `.ogg` gerados ficam em `web/previews/` e são versionados (o site os toca direto).
Sons sem preview mostram "Preview indisponível" e mantêm o link da fonte original.

## Créditos

- Sons de motor por **Legacy_DMC**, **Aquaphobic** e demais autores listados em cada card (links para gta5-mods).
- Pack base / coletânea: **SpiritsCreations** — [FiveM-Engine-Sound-Pack](https://github.com/SpiritsCreations/FiveM-Engine-Sound-Pack).

Todos os direitos dos áudios pertencem aos respectivos autores. Este repositório é
um empacotamento/uso interno do MRI; se algum autor não quiser seu som aqui, é só abrir uma issue.
