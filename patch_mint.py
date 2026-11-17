#!/usr/bin/env python3
"""
Parche de MINT para indexo.html
  1) Limpia todo el formulario de Mint tras mintear y al conectar/desconectar cualquier billetera
  2) La coleccion del JSON (campo collection.name del Metadata URI) aparece en el desplegable
     "Collection" como "New collection: <nombre>" (o selecciona la coleccion existente si coincide)
  3) Verifica la URI automaticamente al pegarla

Uso:  python3 patch_mint.py indexo.html
Crea indexo.html.pre-mint.bak y sobrescribe indexo.html.
Si una ancla no se encuentra o aparece mas de una vez, NO escribe nada.
"""
import sys, shutil

path = sys.argv[1] if len(sys.argv) > 1 else "indexo.html"
text = open(path, encoding="utf-8", newline="").read()

NEW_FUNCS = r"""function mintCollName() {
            return mintState.uriCollName || '';
        }
        function newCollLabel() {
            const n = mintCollName();
            return n ? `${T('mintNewCollection')}: ${n}` : T('mintNewCollection');
        }
        function resetMintForm(keepSuccess) {
            clearTimeout(probeTimer); clearTimeout(mintState.verifyTimer); mintState.probeToken++;
            ['mint-image', 'mint-video', 'mint-name', 'mint-desc', 'mint-external', 'mint-creator', 'mint-collection-name', 'mint-uri']
                .forEach(i => { const e = mel(i); if (e) e.value = ''; });
            const set = (id, fn) => { const e = mel(id); if (e) fn(e); };
            set('mint-royalty', e => e.value = '5');
            set('mint-taxon', e => { e.value = ''; delete e.dataset.touched; });
            set('mint-collection', e => e.innerHTML = '');
            set('mint-category', e => e.innerHTML = '');
            set('mint-f-transferable', e => { e.checked = true; e.disabled = false; });
            set('mint-f-onlyxrp', e => e.checked = true);
            set('mint-f-burnable', e => e.checked = false);
            set('mint-f-mutable', e => e.checked = false);
            set('mint-attrs', e => e.innerHTML = '');
            set('mint-json', e => e.textContent = '');
            set('mint-json-actions', e => e.classList.add('hidden'));
            set('mint-image-status', e => e.innerHTML = '');
            set('mint-verify-box', e => { e.innerHTML = ''; e.classList.add('hidden'); });
            set('mint-preview-media', e => { e.innerHTML = ''; delete e.dataset.key; });
            set('mint-preview-name', e => e.textContent = '—');
            set('mint-sum', e => e.innerHTML = '');
            mintState.attrs = [{ k: '', v: '' }]; mintState.doc = null; mintState.uriChecked = null;
            mintState.uriCollName = ''; mintState.collTouched = false; mintState.autoTried = '';
            mintState.issuerTaxons = new Map(); mintState.taxonFor = null; mintState.rendered = false;
            if (!keepSuccess) { mintState.last = null; set('mint-success', e => { e.innerHTML = ''; e.classList.add('hidden'); }); }
        }
        """

MINT_RECALC_BLOCK = r"""
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

SUBMIT_BLOCK = r"""const keepTaxons = new Map(mintState.issuerTaxons);
                keepTaxons.set(v.taxon, (keepTaxons.get(v.taxon) || 0) + 1);
                resetMintForm(true);
                mintState.issuerTaxons = keepTaxons; mintState.taxonFor = acct;
                renderMintPage();"""

MINT_ANOTHER_NEW = r"""function mintAnother() {
            const keep = mintState.issuerTaxons, acct = connectedAccount;
            resetMintForm();
            mintState.issuerTaxons = keep; mintState.taxonFor = acct;
            renderMintPage(); window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        function mintAnotherOld() {"""

# (ancla de UNA linea, texto nuevo)
EDITS = [
    ("function renderMintPage() {", NEW_FUNCS + "function renderMintPage() {"),
    ("connectedAccount = address; walletType = type; currentUserIsAdmin = !!isAdmin;",
     "connectedAccount = address; walletType = type; currentUserIsAdmin = !!isAdmin; resetMintForm();"),
    ("showToast(T('walletDisc'), 'info');", "resetMintForm(); showToast(T('walletDisc'), 'info');"),
    ("window.addEventListener('DOMContentLoaded', async () => {",
     "window.addEventListener('DOMContentLoaded', async () => {\n            resetMintForm();"),
    ("mintState.issuerTaxons.set(v.taxon, (mintState.issuerTaxons.get(v.taxon) || 0) + 1);", SUBMIT_BLOCK),
    ("function mintAnother() {", MINT_ANOTHER_NEW),
    ("<option value=\"new\">${esc(T('mintNewCollection'))}</option>", "<option value=\"new\">${esc(newCollLabel())}</option>"),
    ("function onCollectionChange(silent) {",
     "function onCollectionChange(silent) {\n            if (!silent) mintState.collTouched = true;"),
    ("const f = readMintForm(), meta = buildMintMetadata(f);",
     "const f = readMintForm(), meta = buildMintMetadata(f);" + MINT_RECALC_BLOCK),
    ("const collName = doc.collection && doc.collection.name ? String(doc.collection.name).slice(0, 80) : '';",
     "const collName = doc.collection && doc.collection.name ? String(doc.collection.name).slice(0, 80) : '';\n            mintState.uriCollName = collName; mintState.collTouched = false; mintRecalc();"),
    ("collName: f.coll,", "collName: mintCollName() || f.coll,"),
    ("${f.coll ? ' · ' + f.coll : ''}", "${mintCollName() ? ' · ' + mintCollName() : (f.coll ? ' · ' + f.coll : '')}"),
]

problems = []
for old, _ in EDITS:
    n = text.count(old)
    if n != 1:
        problems.append((n, old))
if problems:
    print("NO SE ESCRIBIO NADA. Anclas con problema (veces encontradas):")
    for n, old in problems:
        print(f"  x{n}: {old[:90]}")
    print("\nSi ves x0, quiza ya aplicaste ese cambio a mano o el texto es distinto. Pegame esa linea.")
    sys.exit(1)

shutil.copyfile(path, path + ".pre-mint.bak")
for old, new in EDITS:
    text = text.replace(old, new, 1)
    print("OK ", old[:80])
open(path, "w", encoding="utf-8", newline="").write(text)
print("\nListo. Copia de seguridad:", path + ".pre-mint.bak")
