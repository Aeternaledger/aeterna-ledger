#!/usr/bin/env python3
"""
Parche SOLO de coleccion para MINT (indexo.html que ya tiene resetMintForm).
La coleccion leida del JSON (collection.name) aparece en el desplegable "Collection"
como "New collection: <nombre>" y la URI se verifica sola al pegarla.

Uso:  python patch_mint_coleccion.py indexo.html
Crea indexo.html.pre-coleccion.bak. Si algo no coincide, NO escribe nada.
"""
import sys, shutil

path = sys.argv[1] if len(sys.argv) > 1 else "indexo.html"
text = open(path, encoding="utf-8", newline="").read()

# 1) Restos de intentos anteriores (pegados a mano) -> abortar para no duplicar
LEFTOVERS = ["newCollLabel", "mintCollName", "collTouched", "uriCollName", "const collSel = mel('mint-collection')"]
found = [k for k in LEFTOVERS if k in text]
if found:
    print("NO SE ESCRIBIO NADA. El archivo ya contiene restos de cambios de coleccion:", found)
    print("Busca esas palabras con Ctrl+F en indexo.html y pegame las lineas, o restaura una version sin ellas.")
    sys.exit(1)

NEW_FUNCS = r"""function mintCollName() {
            return mintState.uriCollName || '';
        }
        function newCollLabel() {
            const n = mintCollName();
            return n ? `${T('mintNewCollection')}: ${n}` : T('mintNewCollection');
        }
        function refreshCollectionOptions() {"""

RECALC_BLOCK = r"""
            // Colección leída del JSON de la URI: se muestra en la opción "New collection"
            if (safeNorm(mel('mint-uri').value) !== mintState.uriChecked) mintState.uriCollName = '';
            const collSel = mel('mint-collection');
            if (collSel) {
                const optNew = collSel.querySelector('option[value="new"]');
                if (optNew) optNew.textContent = newCollLabel();
                const cn = mintCollName();
                if (!mintState.collTouched && cn) {
                    const hit = collectionList().find(e => e.name && e.name.toLowerCase() === cn.toLowerCase());
                    const want = hit ? 't:' + hit.taxon : 'new';
                    if (collSel.value !== want && [...collSel.options].some(o => o.value === want)) { collSel.value = want; onCollectionChange(true); }
                }
            }
            // Verificación automática al pegar la URI (una sola vez por URI)
            clearTimeout(mintState.verifyTimer);
            const uriNow = safeNorm(mel('mint-uri').value);
            if (uriNow && uriNow !== mintState.uriChecked && uriNow !== mintState.autoTried) {
                mintState.autoTried = uriNow;
                mintState.verifyTimer = setTimeout(verifyMintUri, 900);
            }"""

EDITS = [
    ("function refreshCollectionOptions() {", NEW_FUNCS),
    ("<option value=\"new\">${esc(T('mintNewCollection'))}</option>", "<option value=\"new\">${esc(newCollLabel())}</option>"),
    ("function onCollectionChange(silent) {",
     "function onCollectionChange(silent) {\n            if (!silent) mintState.collTouched = true;"),
    ("const f = readMintForm(), meta = buildMintMetadata(f);",
     "const f = readMintForm(), meta = buildMintMetadata(f);" + RECALC_BLOCK),
    ("const collName = doc.collection && doc.collection.name ? String(doc.collection.name).slice(0, 80) : '';",
     "const collName = doc.collection && doc.collection.name ? String(doc.collection.name).slice(0, 80) : '';\n            mintState.uriCollName = collName; mintState.collTouched = false; mintRecalc();"),
    ("collName: f.coll,", "collName: mintCollName() || f.coll,"),
    ("${f.coll ? ' · ' + f.coll : ''}", "${mintCollName() ? ' · ' + mintCollName() : (f.coll ? ' · ' + f.coll : '')}"),
    # dentro de tu resetMintForm ya existente
    ("mintState.issuerTaxons = new Map(); mintState.taxonFor = null; mintState.rendered = false;",
     "mintState.issuerTaxons = new Map(); mintState.taxonFor = null; mintState.rendered = false;\n    mintState.uriCollName = ''; mintState.collTouched = false; mintState.autoTried = ''; clearTimeout(mintState.verifyTimer);"),
]

problems = [(text.count(old), old) for old, _ in EDITS if text.count(old) != 1]
if problems:
    print("NO SE ESCRIBIO NADA. Anclas con problema (veces encontradas):")
    for n, old in problems:
        print(f"  x{n}: {old[:100]}")
    sys.exit(1)

shutil.copyfile(path, path + ".pre-coleccion.bak")
for old, new in EDITS:
    text = text.replace(old, new, 1)
    print("OK ", old[:80])
open(path, "w", encoding="utf-8", newline="").write(text)
print("\nListo. Copia de seguridad:", path + ".pre-coleccion.bak")
