#!/usr/bin/env python3
"""
Aplica a indexo.html:
  1) Reemplazo de "Tokenization / tokenizar" por NFT (6 idiomas + About + Legal)
  2) Tipografia del menu, categorias, sort e idioma = la del body (font-ui)

Uso:   python3 patch_indexo.py indexo.html
Crea indexo.html.bak (copia de seguridad) y sobrescribe indexo.html.
Cada reemplazo informa cuantas veces se aplico; si alguno da 0, avisa.
"""
import sys, shutil, re

path = sys.argv[1] if len(sys.argv) > 1 else "indexo.html"
src = open(path, encoding="utf-8").read()
shutil.copyfile(path, path + ".bak")
text = src

TEXT_REPLACEMENTS = [
    # Titulos
    ("Tokenization of Unclaimed Universal Elements", "The Unclaimed Universe, Immortalized as NFTs"),
    ("Tokenizing Unowned Elements", "Unowned Elements, Reborn as NFTs"),
    ("Tokenización de Elementos Universales Libre de Reclamo", "El Universo Sin Dueño, Inmortalizado en NFTs"),
    ("Tokenizando Elementos Sin Dueño", "Elementos Sin Dueño, Renacidos como NFTs"),
    ("未所有の宇宙要素のトークン化", "持ち主のいない宇宙を、NFTとして永遠に"),
    ("未所有要素のトークン化", "持ち主のいない要素を、NFTとして新たに"),
    ("미소유 자연 요소의 토큰화", "주인 없는 우주를 NFT로 영원히"),
    ("미소유 요소 토큰화", "주인 없는 요소, NFT로 다시 태어나다"),
    ("无主自然与宇宙元素的代币化", "将无主的宇宙，永久铸为 NFT"),
    ("无主元素代币化", "无主元素，化身 NFT"),
    ("Токенизация ничейных элементов Вселенной", "Вселенная без владельца, увековеченная в NFT"),
    ("Токенизация ничейных объектов", "Ничейные элементы, рождённые как NFT"),
    # About (texto largo)
    ("represented, tokenized and preserved", "represented, minted as NFTs and preserved"),
    ("representadas, tokenizadas y preservadas", "representadas, convertidas en NFTs y preservadas"),
    ("表現され、トークン化され、保存される", "表現され、NFTとして発行され、保存される"),
    ("표현되고, 토큰화되고, 보존될", "표현되고, NFT로 발행되고, 보존될"),
    ("被表达、被代币化，并作为", "被表达、被铸造为 NFT，并作为"),
    ("представить, токенизировать и сохранить", "представить, выпустить в виде NFT и сохранить"),
    # Legal
    ("a unique tokenized representation of the Moon", "a unique NFT representation of the Moon"),
    ("una representación tokenizada única de la Luna", "una representación única de la Luna en forma de NFT"),
]

FONT_REPLACEMENTS = [
    ('<nav class="flex space-x-1 text-xs font-mono overflow-x-auto max-w-full">',
     '<nav class="flex space-x-1 text-xs font-ui overflow-x-auto max-w-full">'),
    ('<div class="relative inline-block text-left font-mono text-xs">',
     '<div class="relative inline-block text-left font-ui text-xs">'),
    ('<div class="flex items-center justify-between font-mono text-xs">',
     '<div class="flex items-center justify-between font-ui text-xs">'),
    ('<div class="flex flex-wrap gap-2 sm:gap-2.5 justify-start w-full font-mono text-xs">',
     '<div class="flex flex-wrap gap-2 sm:gap-2.5 justify-start w-full font-ui text-xs">'),
]

for old, new in TEXT_REPLACEMENTS + FONT_REPLACEMENTS:
    n = text.count(old)
    text = text.replace(old, new)
    print(f"{'OK ' if n else 'OJO'} x{n}  {old[:60]}")

# Clase font-ui (misma fuente que el body)
css_rule = ".font-ui { font-family: system-ui, -apple-system, sans-serif; }"
if css_rule not in text:
    m = re.search(r"(body \{[^}]*\}\n)", text)
    if m:
        text = text.replace(m.group(1), m.group(1) + "        " + css_rule + "\n", 1)
        print("OK  regla .font-ui añadida")
    else:
        print("OJO no encontré la regla body {…}; añade manualmente:", css_rule)

# Comprobación final
left = re.findall(r"[Tt]okeniz\w*|トークン化|토큰화|代币化|Токениз\w*", text)
print("\nRestos de 'tokenization':", left if left else "ninguno")

open(path, "w", encoding="utf-8").write(text)
print("Listo. Copia de seguridad:", path + ".bak")
