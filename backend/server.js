/* =====================================================================
   AETERNA LEDGER — Backend (Xaman / XRPL Mainnet)
   Compatible con el nuevo index.html
   Variables de entorno (Render → Environment):
     XUMM_APIKEY (o XUMM_API_KEY), XUMM_APISECRET (o XUMM_API_SECRET)
     TREASURY_ADDRESS, MINTING_ADDRESS, MINTING_SECRET, PORT
   Opcionales:
     ALLOWED_ORIGINS  → dominios permitidos por CORS, separados por coma (ej. https://tudominio.com)
     ADMIN_API_KEY    → habilita /api/mint-nft (deshabilitado si no existe)
     PLATFORM_FEE_BPS → comisión de la plataforma en puntos básicos sobre cada compra del Marketplace (150 = 1.5 %, valor por defecto). 0 la desactiva. Máx. 2000
     PLATFORM_FEE_STORE_BPS → comisión para compras de la Store (por defecto 150 = 1.5 %; 0 para no cobrar en la Store)
     PLATFORM_FEE_BIFROST   → 'off' para no cobrar comisión a usuarios de Bifrost (por defecto 'on')
     STORE_ADDRESSES  → cuentas cuyas ventas son de la Store, separadas por coma (por defecto MINTING_ADDRESS)
     REGISTRY_FILE    → ruta del registro del Marketplace (por defecto ./data/registry.json; en Render usa un Disk, ej. /var/data/registry.json)
   ===================================================================== */
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { XummSdk } = require('xumm-sdk');
const xrpl = require('xrpl');

const PORT = process.env.PORT || 3000;
const XUMM_API_KEY = process.env.XUMM_API_KEY || process.env.XUMM_APIKEY;
const XUMM_API_SECRET = process.env.XUMM_API_SECRET || process.env.XUMM_APISECRET;
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS;
const MINTING_ADDRESS = process.env.MINTING_ADDRESS;
const MINTING_SECRET = process.env.MINTING_SECRET;
const bpsEnv = (name, def) => { const n = parseInt(process.env[name] ?? String(def), 10); return Number.isFinite(n) ? Math.min(2000, Math.max(0, n)) : def; };
const FEE_BPS = bpsEnv('PLATFORM_FEE_BPS', 150);
const FEE_STORE_BPS = bpsEnv('PLATFORM_FEE_STORE_BPS', 150);
const FEE_BIFROST = String(process.env.PLATFORM_FEE_BIFROST || 'on').toLowerCase() !== 'off';
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const XRPL_WS = 'wss://xrplcluster.com';
const RIPPLE_EPOCH = 946684800;

const xumm = new XummSdk(XUMM_API_KEY, XUMM_API_SECRET);

const app = express();
app.set('trust proxy', 1);   // Render está detrás de un proxy: necesario para limitar por IP
const origins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors(origins.length ? { origin: origins } : undefined));
app.use(express.json({ limit: '100kb' }));

/* ---------- Utilidades ---------- */
const HEX64 = /^[0-9A-Fa-f]{64}$/;
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const isAddr = a => typeof a === 'string' && xrpl.isValidClassicAddress(a);
const STORE_ADDRESSES = (process.env.STORE_ADDRESSES || MINTING_ADDRESS || '').split(',').map(x => x.trim()).filter(isAddr);
// comisión redondeada hacia arriba (mínimo 1 drop si el precio > 0)
function calcFee(amountDrops, bps) {
    const amt = BigInt(amountDrops);
    if (!bps || amt <= 0n) return 0n;
    const fee = (amt * BigInt(bps) + 9999n) / 10000n;
    return fee < 1n ? 1n : fee;
}

// Convierte el precio a drops sin errores de coma flotante. Prioriza amountDrops (lo envía el front).
function readDrops(body, { allowZero = false } = {}) {
    let drops;
    if (body.amountDrops !== undefined && /^\d+$/.test(String(body.amountDrops))) drops = String(body.amountDrops);
    else {
        try { drops = xrpl.xrpToDrops(String(body.priceXRP)); }
        catch (e) { throw new HttpError(400, 'Precio inválido (máximo 6 decimales).'); }
    }
    if (!allowZero && BigInt(drops) <= 0n) throw new HttpError(400, 'El precio debe ser mayor que 0.');
    return drops;
}

async function withClient(fn) {
    const client = new xrpl.Client(XRPL_WS);
    await client.connect();
    try { return await fn(client); }
    finally { try { await client.disconnect(); } catch (e) { /* ignorar */ } }
}
const rippledError = e => (e && e.data && e.data.error) || (e && e.error) || null;

async function createPayload(txjson, instruction, extraOptions) {
    const created = await xumm.payload.create({
        txjson,
        options: { expire: 5, ...(extraOptions || {}) },   // el QR vence en 5 minutos
        custom_meta: instruction ? { instruction: String(instruction).slice(0, 200) } : undefined
    });
    if (!created || !created.uuid) throw new HttpError(502, 'Xaman no pudo crear el payload.');
    return { uuid: created.uuid, qr_code: created.refs.qr_png, deep_link: created.next.always };
}
// Xaman (por defecto): crea el payload y devuelve el QR.  Bifrost (wallet:'bifrost'): devuelve la transacción sin firmar
// para que la web la envíe a la billetera por WalletConnect (xrpl_signTransaction).
async function respondTx(req, res, txjson, instruction, { options, extra } = {}) {
    if (req.body && req.body.wallet === 'bifrost') return res.json({ success: true, wallet: 'bifrost', txjson, ...(extra || {}) });
    res.json({ success: true, ...(await createPayload(txjson, instruction, options)), ...(extra || {}) });
}
const wrap = handler => async (req, res) => {
    try { await handler(req, res); }
    catch (e) {
        const status = e.status || 500;
        if (status >= 500) console.error(`[${req.method} ${req.path}]`, e);
        res.status(status).json({ success: false, error: e.message || 'Error interno del servidor' });
    }
};

// Lee una oferta NFTokenOffer del ledger (null si no existe)
async function getOffer(client, index) {
    try {
        const r = await client.request({ command: 'ledger_entry', index, ledger_index: 'validated' });
        const node = r.result.node;
        return node && node.LedgerEntryType === 'NFTokenOffer' ? node : null;
    } catch (e) {
        const code = rippledError(e);
        if (code === 'entryNotFound' || code === 'malformedRequest' || code === 'objectNotFound') return null;
        throw e;
    }
}
async function getSellOffers(client, nftId) {
    try {
        const r = await client.request({ command: 'nft_sell_offers', nft_id: nftId });
        return r.result.offers || [];
    } catch (e) {
        if (rippledError(e) === 'objectNotFound') return [];
        throw e;
    }
}
const isExpired = exp => !!exp && exp + RIPPLE_EPOCH <= Date.now() / 1000;

/* ---------- Límite de peticiones por IP (en memoria) ---------- */
const hits = new Map();
setInterval(() => hits.clear(), 60 * 1000).unref();
const rateLimit = max => (req, res, next) => {
    const k = req.ip + req.path.split('/').slice(0, 3).join('/');
    const n = (hits.get(k) || 0) + 1; hits.set(k, n);
    if (n > max) return res.status(429).json({ success: false, error: 'Demasiadas solicitudes. Espera un minuto.' });
    next();
};
app.use('/api/', rateLimit(90));

/* ---------- Registro del Marketplace ----------
   XRPL no permite listar "todas las ofertas activas". Aquí se guardan los NFTs publicados desde tu web
   (de CUALQUIER emisor). Cada entrada se verifica contra el ledger y las que dejan de estar a la venta se eliminan solas. */
const REGISTRY_FILE = process.env.REGISTRY_FILE || path.join(__dirname, 'data', 'registry.json');
const REGISTRY_MAX = 5000;
const CATEGORIES = ['Planets & Moons', 'Stars & Stellar Systems', 'Fauna & Wild Species', 'Botany & Master Flora', 'Minerals & Pure Elements', 'Global Geography & Waters', 'Concepts, Ideas & Knowledge', 'Symbols, Archetypes & Culture'];
let registry = {};
try { registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); } catch (e) { registry = {}; }
let saveTimer = null;
function saveRegistry() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
            const tmp = REGISTRY_FILE + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(registry));
            fs.renameSync(tmp, REGISTRY_FILE);
        } catch (e) { console.error('[registry] no se pudo guardar:', e.message); }
    }, 500);
}
// ¿Tiene una oferta de venta pública en XRP, vigente y hecha por su dueño actual?
// Devuelve { seller } si hay oferta pública vigente de su dueño actual; null si no.
async function hasPublicListing(client, id) {
    const offers = (await getSellOffers(client, id)).filter(o => (o.flags & 1) && typeof o.amount === 'string' && !o.destination && !isExpired(o.expiration));
    if (!offers.length) return null;
    try {
        const info = await client.request({ command: 'nft_info', nft_id: id });
        if (info.result.is_burned) return null;
        const mine = offers.find(o => o.owner === info.result.owner);
        return mine ? { seller: mine.owner } : null;
    } catch (e) { return { seller: offers[0].owner }; }   // si el servidor no soporta nft_info, confiar en la oferta
}
app.get('/api/market-registry', (req, res) => {
    const ids = Object.entries(registry).sort((a, b) => b[1].ts - a[1].ts).slice(0, 2000)
        .map(([nftokenId, v]) => ({ nftokenId, category: v.category || null, seller: v.seller || null, ts: v.ts }));
    res.json({ success: true, ids });
});
app.post('/api/market-registry', rateLimit(30), wrap(async (req, res) => {
    const { nftokenId, category } = req.body;
    if (!HEX64.test(nftokenId || '')) throw new HttpError(400, 'NFTokenID inválido.');
    const id = nftokenId.toUpperCase();
    if (!registry[id] && Object.keys(registry).length >= REGISTRY_MAX) throw new HttpError(503, 'Registro lleno.');
    // Los nodos públicos pueden ir 1-2 ledgers atrás: reintentar unos segundos antes de rechazar
    let ok = null;
    for (let i = 0; i < 4 && !ok; i++) {
        if (i) await new Promise(r => setTimeout(r, 3000));
        ok = await withClient(client => hasPublicListing(client, id));
    }
    if (!ok) throw new HttpError(404, 'Este NFT no tiene una oferta de venta pública activa en XRPL.');
    registry[id] = { category: CATEGORIES.includes(category) ? category : (registry[id] && registry[id].category) || null, seller: ok.seller, ts: Date.now() };
    saveRegistry();
    res.json({ success: true });
}));
// Limpieza periódica: elimina del registro lo que ya no está a la venta (vendido, cancelado o expirado)
async function pruneRegistry() {
    const stale = Object.entries(registry).filter(([, v]) => Date.now() - v.ts > 10 * 60 * 1000).map(([id]) => id);
    if (!stale.length) return;
    try {
        await withClient(async client => {
            for (const id of stale) {
                try { const l = await hasPublicListing(client, id); if (!l) { delete registry[id]; } else { registry[id].ts = Date.now(); registry[id].seller = l.seller; } }
                catch (e) { /* conservar ante errores de red */ }
            }
        });
        saveRegistry();
    } catch (e) { console.error('[registry] limpieza falló:', e.message); }
}
setInterval(pruneRegistry, 30 * 60 * 1000).unref();

app.get('/api/fee-info', (req, res) => {
    res.json({ success: true, bps: FEE_BPS, storeBps: FEE_STORE_BPS, bifrostApplies: FEE_BIFROST, treasury: TREASURY_ADDRESS || null, storeAddresses: STORE_ADDRESSES });
});
app.get('/api/wallet-info/:address', wrap(async (req, res) => {
    if (!isAddr(req.params.address)) throw new HttpError(400, 'Dirección inválida.');
    res.json({ success: true, isAdmin: !!TREASURY_ADDRESS && req.params.address === TREASURY_ADDRESS });
}));

/* ---------- Salud ---------- */
app.get('/', (req, res) => res.json({ ok: true, service: 'aeterna-ledger-backend' }));
app.get('/health', (req, res) => res.json({ ok: true }));

/* ---------- 1. Conectar billetera (SignIn) ---------- */
app.post('/api/connect-wallet', wrap(async (req, res) => {
    res.json(await createPayload({ TransactionType: 'SignIn' }, 'Aeterna Ledger: sign in'));
}));

/* ---------- 2. Balance XRP ---------- */
app.get('/api/balances/:address', wrap(async (req, res) => {
    if (!isAddr(req.params.address)) throw new HttpError(400, 'Dirección inválida.');
    try {
        const xrp = await withClient(async client => {
            const r = await client.request({ command: 'account_info', account: req.params.address, ledger_index: 'validated' });
            return xrpl.dropsToXrp(r.result.account_data.Balance);
        });
        res.json({ success: true, xrp });
    } catch (e) {
        if (rippledError(e) === 'actNotFound') return res.json({ success: true, xrp: 0 });
        throw e;
    }
}));

/* ---------- 3. Pago directo a tesorería (heredado) ---------- */
app.post('/api/buy-nft', wrap(async (req, res) => {
    const drops = readDrops(req.body);
    if (!isAddr(TREASURY_ADDRESS)) throw new HttpError(500, 'TREASURY_ADDRESS no configurada.');
    res.json(await createPayload({ TransactionType: 'Payment', Destination: TREASURY_ADDRESS, Amount: drops }, 'Aeterna Ledger: payment'));
}));

/* ---------- 4. Mint firmado por el usuario ---------- */
app.post('/api/mint-payload', wrap(async (req, res) => {
    const { account, title, category, royalty } = req.body;
    if (!isAddr(account)) throw new HttpError(400, 'Cuenta inválida.');
    if (!title || typeof title !== 'string') throw new HttpError(400, 'Falta el título.');
    const metadataURI = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf4dfuyljbad43rk2q5i4chkuai/' + encodeURIComponent(title);
    let taxon = 1;
    if (category && category.includes('Stars')) taxon = 2;
    else if (category && category.includes('Botanical')) taxon = 3;
    else if (category && category.includes('Concepts')) taxon = 4;
    // TransferFee en XRPL: 1 unidad = 0.001 %  (2.5 % → 2500, máximo 50000)
    const pct = parseFloat(royalty ?? 2.5);
    const transferFee = Math.min(50000, Math.max(0, Math.round((isNaN(pct) ? 2.5 : pct) * 1000)));
    await respondTx(req, res, {
        TransactionType: 'NFTokenMint', Account: account, NFTokenTaxon: taxon,
        Flags: 8, URI: Buffer.from(metadataURI).toString('hex').toUpperCase(), TransferFee: transferFee
    }, 'Aeterna Ledger: mint');
}));

/* ---------- 5. COMPRAR: aceptar una oferta de venta (NFTokenAcceptOffer) ---------- */
app.post('/api/buy-nft-offer', wrap(async (req, res) => {
    const { buyerAccount, nftokenId, ownerAccount } = req.body;
    if (!isAddr(buyerAccount)) throw new HttpError(400, 'Cuenta compradora inválida.');
    if (!HEX64.test(nftokenId || '')) throw new HttpError(400, 'NFTokenID inválido.');
    let offerIndex = req.body.offerIndex || req.body.sellOfferIndex;
    if (offerIndex && !HEX64.test(offerIndex)) throw new HttpError(400, 'Índice de oferta inválido.');
    const expectedDrops = (req.body.amountDrops !== undefined || req.body.priceXRP !== undefined) ? readDrops(req.body, { allowZero: true }) : null;

    const offer = await withClient(async client => {
        // Si el front no envía el índice, se busca la oferta de venta más barata del dueño en el ledger.
        if (!offerIndex) {
            const valid = (await getSellOffers(client, nftokenId))
                .filter(o => typeof o.amount === 'string' && !isExpired(o.expiration) && (!o.destination || o.destination === buyerAccount) && (!ownerAccount || o.owner === ownerAccount))
                .sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1));
            if (!valid.length) throw new HttpError(410, 'Este NFT no tiene una oferta de venta activa.');
            offerIndex = valid[0].nft_offer_index;
        }
        const node = await getOffer(client, offerIndex);
        if (!node) throw new HttpError(410, 'La oferta ya no existe en XRPL (vendida o cancelada).');
        return node;
    });
    if (offer.NFTokenID !== nftokenId.toUpperCase()) throw new HttpError(400, 'La oferta no corresponde a este NFT.');
    if (!(offer.Flags & 1)) throw new HttpError(400, 'La oferta indicada no es una oferta de venta.');
    if (typeof offer.Amount !== 'string') throw new HttpError(400, 'Solo se admiten ofertas en XRP.');
    if (isExpired(offer.Expiration)) throw new HttpError(410, 'La oferta expiró.');
    if (offer.Destination && offer.Destination !== buyerAccount) throw new HttpError(403, 'Esta oferta es privada para otra cuenta.');
    if (offer.Owner === buyerAccount) throw new HttpError(400, 'No puedes comprar tu propio NFT.');
    if (expectedDrops !== null && expectedDrops !== offer.Amount) throw new HttpError(409, 'El precio cambió. Actualiza la lista e inténtalo de nuevo.');

    // Comisión de la plataforma: se cobra EN LA MISMA transacción atómica (Batch / XLS-56) que la compra.
    const isStoreSale = STORE_ADDRESSES.includes(offer.Owner);
    let feeDrops = calcFee(offer.Amount, isStoreSale ? FEE_STORE_BPS : FEE_BPS);
    if (req.body.wallet === 'bifrost' && !FEE_BIFROST) feeDrops = 0n;
    if (!isAddr(TREASURY_ADDRESS) || buyerAccount === TREASURY_ADDRESS) feeDrops = 0n;
    const maxFee = req.body.maxFeeDrops;
    if (feeDrops > 0n && maxFee !== undefined && /^\d+$/.test(String(maxFee)) && feeDrops > BigInt(maxFee)) throw new HttpError(409, 'La comisión cambió. Actualiza la página e inténtalo de nuevo.');

    const priceXrp = xrpl.dropsToXrp(offer.Amount);
    if (feeDrops === 0n) {
        return respondTx(req, res, { TransactionType: 'NFTokenAcceptOffer', Account: buyerAccount, NFTokenSellOffer: offerIndex },
            `Aeterna Ledger: buy NFT for ${priceXrp} XRP`, { extra: { feeDrops: '0', totalDrops: offer.Amount } });
    }
    const batch = await withClient(client => buildBuyBatch(client, buyerAccount, offerIndex, feeDrops));
    const total = (BigInt(offer.Amount) + feeDrops).toString();
    return respondTx(req, res, batch, `Aeterna Ledger: buy NFT ${priceXrp} XRP + ${xrpl.dropsToXrp(feeDrops.toString())} XRP fee`,
        { options: { signer: buyerAccount }, extra: { feeDrops: feeDrops.toString(), totalDrops: total } });
}));

// Batch atómico (XLS-56, BatchV1_1): [aceptar la oferta de venta, pagar la comisión a la tesorería]. Si una falla, ninguna se aplica.
async function buildBuyBatch(client, buyer, offerIndex, feeDrops) {
    const acc = await client.request({ command: 'account_info', account: buyer, ledger_index: 'current' });
    const seq = acc.result.account_data.Sequence;
    const f = await client.request({ command: 'fee' });
    const unit = Math.max(Number(f.result.drops.base_fee), Number(f.result.drops.open_ledger_fee || 0));
    const INNER = 1073741824;                                  // tfInnerBatchTxn
    return {
        TransactionType: 'Batch', Account: buyer, Sequence: seq, Flags: 65536,   // tfAllOrNothing
        Fee: String(Math.ceil(unit * 4 * 1.3)),                // 2×base + 2 transacciones internas (+30 % de margen)
        RawTransactions: [
            { RawTransaction: { TransactionType: 'NFTokenAcceptOffer', Account: buyer, NFTokenSellOffer: offerIndex, Sequence: seq + 1, Fee: '0', Flags: INNER, SigningPubKey: '' } },
            { RawTransaction: { TransactionType: 'Payment', Account: buyer, Destination: TREASURY_ADDRESS, Amount: feeDrops.toString(), Sequence: seq + 2, Fee: '0', Flags: INNER, SigningPubKey: '' } }
        ]
    };
}

/* ---------- 6. PUBLICAR EN VENTA (NFTokenCreateOffer, tfSellNFToken) ---------- */
app.post('/api/list-nft-offer', wrap(async (req, res) => {
    const { sellerAccount, nftokenId } = req.body;
    if (!isAddr(sellerAccount)) throw new HttpError(400, 'Cuenta vendedora inválida.');
    if (!HEX64.test(nftokenId || '')) throw new HttpError(400, 'NFTokenID inválido.');
    const drops = readDrops(req.body);
    await respondTx(req, res, {
        TransactionType: 'NFTokenCreateOffer', Account: sellerAccount, NFTokenID: nftokenId.toUpperCase(), Amount: drops, Flags: 1
    }, `Aeterna Ledger: sell NFT for ${xrpl.dropsToXrp(drops)} XRP`);
}));

/* ---------- 7. TRANSFERIR a otra cuenta (oferta privada de 0 XRP con Destination) ---------- */
app.post('/api/transfer-nft-offer', wrap(async (req, res) => {
    const { sellerAccount, nftokenId, destination } = req.body;
    if (!isAddr(sellerAccount) || !isAddr(destination)) throw new HttpError(400, 'Dirección inválida.');
    if (sellerAccount === destination) throw new HttpError(400, 'El destino no puede ser tu propia cuenta.');
    if (!HEX64.test(nftokenId || '')) throw new HttpError(400, 'NFTokenID inválido.');
    await respondTx(req, res, {
        TransactionType: 'NFTokenCreateOffer', Account: sellerAccount, NFTokenID: nftokenId.toUpperCase(), Amount: '0', Destination: destination, Flags: 1
    }, `Aeterna Ledger: transfer NFT to ${destination}`);
}));

/* ---------- 8. CANCELAR OFERTAS (NFTokenCancelOffer) ----------
   Requiere el ÍNDICE de la oferta (nft_offer_index), no el NFTokenID.
   Acepta: offerIndexes[] | offerIndex | nftokenId (heredado: si es un NFTokenID, se buscan sus ofertas del vendedor).  */
app.post('/api/cancel-nft-offer', wrap(async (req, res) => {
    const { sellerAccount } = req.body;
    if (!isAddr(sellerAccount)) throw new HttpError(400, 'Cuenta vendedora inválida.');
    const candidates = [...new Set([
        ...(Array.isArray(req.body.offerIndexes) ? req.body.offerIndexes : []),
        req.body.offerIndex, req.body.nftokenId
    ].filter(x => typeof x === 'string' && HEX64.test(x)).map(x => x.toUpperCase()))].slice(0, 20);
    if (!candidates.length) throw new HttpError(400, 'Faltan parámetros: offerIndex u offerIndexes.');

    const offers = await withClient(async client => {
        const found = [];
        for (const idx of candidates) {
            const node = await getOffer(client, idx);
            if (node) { if (node.Owner === sellerAccount) found.push(idx); }
        }
        if (found.length) return found;
        // Compatibilidad: el valor recibido podía ser un NFTokenID → buscar las ofertas de venta de ese NFT que pertenecen al vendedor.
        const nftId = (req.body.nftId || req.body.nftokenId || '').toUpperCase();
        if (HEX64.test(nftId)) return (await getSellOffers(client, nftId)).filter(o => o.owner === sellerAccount).map(o => o.nft_offer_index);
        return [];
    });
    if (!offers.length) throw new HttpError(410, 'No hay ofertas activas tuyas para cancelar (ya canceladas o vendidas).');
    await respondTx(req, res, {
        TransactionType: 'NFTokenCancelOffer', Account: sellerAccount, NFTokenOffers: offers
    }, 'Aeterna Ledger: cancel sale');
}));

/* ---------- 9. Estado de la firma ---------- */
app.get('/api/check-status/:uuid', wrap(async (req, res) => {
    if (!/^[0-9a-fA-F-]{36}$/.test(req.params.uuid)) throw new HttpError(400, 'UUID inválido.');
    const info = await xumm.payload.get(req.params.uuid);
    if (!info) throw new HttpError(404, 'Payload no encontrado.');
    const { signed, expired, cancelled, resolved } = info.meta;
    if (signed) {
        const account = info.response.account;
        return res.json({ signed: true, expired: false, account, txHash: info.response.txid || null, isAdmin: !!TREASURY_ADDRESS && account === TREASURY_ADDRESS });
    }
    if (expired) return res.json({ signed: false, expired: true });
    if (cancelled || resolved) return res.json({ signed: false, expired: false, rejected: true });   // el usuario rechazó en Xaman
    res.json({ signed: false, expired: false });
}));

/* ---------- 10. Mint automático desde la cuenta emisora (SOLO ADMIN) ----------
   Antes estaba abierto a cualquiera en Internet. Ahora exige la cabecera x-admin-key y ADMIN_API_KEY en Render. */
app.post('/api/mint-nft', wrap(async (req, res) => {
    const provided = Buffer.from(String(req.get('x-admin-key') || ''));
    const expected = Buffer.from(String(ADMIN_API_KEY || ''));
    if (!ADMIN_API_KEY || provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) throw new HttpError(403, 'No autorizado.');
    if (!MINTING_SECRET) throw new HttpError(500, 'MINTING_SECRET no configurada.');
    const { title, category, royalty } = req.body;
    if (!title) throw new HttpError(400, 'Falta el título.');
    const metadataURI = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf4dfuyljbad43rk2q5i4chkuai/' + encodeURIComponent(title);
    const pct = parseFloat(royalty ?? 2.5);
    const transferFee = Math.min(50000, Math.max(0, Math.round((isNaN(pct) ? 2.5 : pct) * 1000)));
    let taxon = 1;
    if (category && category.includes('Zodiac')) taxon = 2;
    else if (category && category.includes('Botanical')) taxon = 3;
    else if (category && category.includes('Universal')) taxon = 4;
    const wallet = xrpl.Wallet.fromSeed(MINTING_SECRET);
    const result = await withClient(client => client.submitAndWait({
        TransactionType: 'NFTokenMint', Account: wallet.classicAddress, NFTokenTaxon: taxon, Flags: 8,
        URI: xrpl.convertStringToHex(metadataURI), TransferFee: transferFee
    }, { wallet }));
    res.json({ success: true, message: 'NFT minted successfully on XRPL', txHash: result.result.hash, issuer: wallet.classicAddress });
}));

app.listen(PORT, () => console.log(`Servidor de Aeterna Ledger escuchando en el puerto ${PORT}`));