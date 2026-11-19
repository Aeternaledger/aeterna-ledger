#!/usr/bin/env python3
"""
Parche 3D para indexo.html: soporte de archivos GLB/GLTF en el campo "video / animation_url".
 - Detecta si el archivo es un modelo 3D (por extension .glb/.gltf o leyendo sus primeros bytes "glTF")
 - En el detalle del NFT lo muestra con el visor <model-viewer> (rotar con el dedo/raton)
 - La pestaña pasa de "Video" a "3D" y la etiqueta de la tarjeta tambien
 - Prueba todos los gateways IPFS (Orbitor, ipfs.io, dweb.link, Pinata) si uno falla

Uso:  python patch_glb.py indexo.html
Crea indexo.html.pre-glb.bak. Si una ancla no coincide, NO escribe nada.
"""
import sys, shutil

path = sys.argv[1] if len(sys.argv) > 1 else "indexo.html"
text = open(path, encoding="utf-8", newline="").read()

if "detect3d" in text:
    print("NO SE ESCRIBIO NADA: el archivo ya contiene el parche 3D (detect3d).")
    sys.exit(1)

HELPERS = r"""/* ----- Modelos 3D (GLB/GLTF) en el campo video / animation_url ----- */
        const MODEL_VIEWER_SRC = 'https://cdn.jsdelivr.net/npm/@google/model-viewer@3.5.0/dist/model-viewer-umd.min.js';
        const model3dCache = new Map();
        const isModelUrl = u => /\.(glb|gltf)(\?.*)?$/i.test(u || '');
        // Lee solo los primeros bytes del archivo: un GLB empieza con "glTF". true / false / null (no se pudo leer)
        async function sniff3d(raw) {
            const n = raw.startsWith('ipfs://') ? CONFIG.IPFS_GATEWAYS.length : 1;
            for (let g = 0; g < n; g++) {
                const url = resolveMediaUrl(raw, g); if (!url) return null;
                try {
                    const res = await fetchT(url, {}, 9000);
                    if (!res.ok) continue;
                    const ct = (res.headers.get('content-type') || '').toLowerCase();
                    if (/model\/gltf/.test(ct)) { try { res.body.cancel(); } catch (e) {} return true; }
                    if (ct.startsWith('video/') || ct.startsWith('image/')) { try { res.body.cancel(); } catch (e) {} return false; }
                    const reader = res.body.getReader(), { value } = await reader.read();
                    try { reader.cancel(); } catch (e) {}
                    if (value && value.length >= 4) return value[0] === 0x67 && value[1] === 0x6C && value[2] === 0x54 && value[3] === 0x46;
                } catch (e) { /* probar el siguiente gateway */ }
            }
            return null;
        }
        async function detect3d(nft) {
            if (nft.is3d !== undefined) return nft.is3d;
            const raw = nft.video;
            if (!raw) return (nft.is3d = false);
            let r;
            if (isModelUrl(raw)) r = true;
            else if (model3dCache.has(raw)) r = model3dCache.get(raw);
            else { r = await sniff3d(raw); if (r !== null) model3dCache.set(raw, r); }
            nft.is3d = r === true;
            return nft.is3d;
        }
        async function render3d(c, nft) {
            c.innerHTML = '<div class="spinner"></div>';
            try { await loadScript(MODEL_VIEWER_SRC); } catch (e) { c.innerHTML = `<div class="text-slate-500 text-xs font-mono">${esc(T('noMedia'))}</div>`; return; }
            if (!c.isConnected || currentActiveDetailNft !== nft) return;
            const raw = nft.video; let gw = 0;
            const mv = document.createElement('model-viewer');
            mv.setAttribute('src', resolveMediaUrl(raw, 0));
            mv.setAttribute('alt', nft.title || '3D');
            ['camera-controls', 'auto-rotate', 'shadow-intensity=1', 'touch-action=pan-y'].forEach(a => { const [k, v] = a.split('='); mv.setAttribute(k, v === undefined ? '' : v); });
            mv.style.cssText = 'width:100%;height:100%;min-height:280px;background:transparent;';
            mv.addEventListener('error', () => {
                gw++;
                if (raw.startsWith('ipfs://') && gw < CONFIG.IPFS_GATEWAYS.length) mv.setAttribute('src', resolveMediaUrl(raw, gw));
                else c.innerHTML = `<div class="text-slate-500 text-xs font-mono">${esc(T('noMedia'))}</div>`;
            });
            c.innerHTML = ''; c.appendChild(mv);
        }
        function renderCardMedia(nft, cls = 'w-full h-full object-contain') {"""

SWITCH_BLOCK = r"""bv.textContent = nft.is3d ? '🧊 3D' : '🎬 Video';
            if (type === 'video' && vu && nft.is3d === undefined) {
                c.innerHTML = '<div class="spinner"></div>'; bv.className = on; bi.className = off;
                const tok = nft.nftokenId;
                detect3d(nft).then(() => { if (currentActiveDetailNft && currentActiveDetailNft.nftokenId === tok) switchDetailMedia('video'); });
                return;
            }
            if (type === 'video' && vu && nft.is3d) { render3d(c, nft); bv.className = on; bi.className = off; return; }
            if (type === 'video' && vu) {"""

# (ancla de una linea, nuevo texto, veces esperadas)
EDITS = [
    ("function renderCardMedia(nft, cls = 'w-full h-full object-contain') {", HELPERS, 1),
    ("const iu = resolveMediaUrl(nft.img);",
     "const iu = resolveMediaUrl(nft.img);\n            if (!iu && nft.video && nft.is3d) return `<div class=\"w-full h-full bg-slate-900 flex items-center justify-center text-slate-300 text-xs font-mono\">🧊 3D</div>`;", 1),
    ("if (type === 'video' && vu) {", SWITCH_BLOCK, 1),
    ("it.rawCategory = m.category ||",
     "if (it.video && !it.img) detect3d(it).then(() => scheduleRender());\n            it.rawCategory = m.category ||", 1),
    ("it.mediaOverride = !!(",
     "if (it.is3dFor !== it.video) { it.is3d = undefined; it.is3dFor = it.video; }\n            it.mediaOverride = !!(", 1),
    ("\">🎬 Video</span>'", "\">' + (nft.is3d ? '🧊 3D' : '🎬 Video') + '</span>'", 2),
]

problems = [(text.count(old), n, old) for old, _, n in EDITS if text.count(old) != n]
if problems:
    print("NO SE ESCRIBIO NADA. Anclas con problema (encontradas / esperadas):")
    for found, exp, old in problems:
        print(f"  x{found} / x{exp}: {old[:100]}")
    sys.exit(1)

shutil.copyfile(path, path + ".pre-glb.bak")
for old, new, _ in EDITS:
    text = text.replace(old, new)
    print("OK ", old[:80])
open(path, "w", encoding="utf-8", newline="").write(text)
print("\nListo. Copia de seguridad:", path + ".pre-glb.bak")
