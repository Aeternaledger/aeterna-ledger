const express = require('express');
const cors = require('cors');
const { XummSdk } = require('xumm-sdk');
const xrpl = require('xrpl');
require('dotenv').config();
const xumm = new XummSdk(process.env.XUMM_API_KEY, process.env.XUMM_API_SECRET);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const XUMM_API_KEY = process.env.XUMM_API_KEY || process.env.XUMM_APIKEY;
const XUMM_API_SECRET = process.env.XUMM_API_SECRET || process.env.XUMM_APISECRET;

const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS;
const MINTING_ADDRESS = process.env.MINTING_ADDRESS;
const MINTING_SECRET = process.env.MINTING_SECRET;

// Inicializar SDK de Xaman
const Sdk = new XummSdk(XUMM_API_KEY, XUMM_API_SECRET);

// Almacén temporal de estados de payloads en memoria
const activePayloads = {};

// 1. Endpoint para conectar billetera genérica con Xaman
app.post('/api/connect-wallet', async (req, res) => {
    try {
        const payload = {
            txjson: {
                TransactionType: "SignIn"
            }
        };

        const created = await Sdk.payload.create(payload);
        if (!created) {
            return res.status(500).json({ error: 'No se pudo crear el payload en Xaman' });
        }

        activePayloads[created.uuid] = { signed: false, account: null };

        res.json({
            uuid: created.uuid,
            qr_code: created.refs.qr_png,
            deep_link: created.next.always
        });
    } catch (error) {
        console.error('Error en /api/connect-wallet:', error);
        res.status(500).json({ error: error.message });
    }
});

// 2. Endpoint unificado para consultar el balance de XRP (Mainnet)
app.get('/api/balances/:address', async (req, res) => {
    const address = req.params.address;
    let client;
    try {
        client = new xrpl.Client('wss://xrplcluster.com');
        await client.connect();

        const response = await client.request({
            command: 'account_info',
            account: address,
            ledger_index: 'validated'
        });

        await client.disconnect();

        const balanceDrops = response.result.account_data.Balance;
        const balanceXRP = xrpl.dropsToXrp(balanceDrops);

        res.json({ success: true, xrp: balanceXRP });
    } catch (error) {
        if (client && client.isConnected()) {
            await client.disconnect();
        }
        console.error('Error al consultar balance XRPL:', error.message);
        
        if (error.data && error.data.error === 'actNotFound') {
            return res.json({ success: true, xrp: 0 });
        }

        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. Endpoint de Compra / Pago dirigido a la Tesorería
app.post('/api/buy-nft', async (req, res) => {
    try {
        const { priceXRP } = req.body;
        const drops = Math.floor(parseFloat(priceXRP) * 1000000).toString();

        const payload = {
            txjson: {
                TransactionType: "Payment",
                Destination: TREASURY_ADDRESS,
                Amount: drops
            }
        };

        const created = await Sdk.payload.create(payload);
        if (!created) {
            return res.status(500).json({ error: 'Error al generar la orden de pago en Xaman' });
        }

        activePayloads[created.uuid] = { signed: false, type: 'buy', price: priceXRP };

        res.json({
            uuid: created.uuid,
            qr_code: created.refs.qr_png,
            deep_link: created.next.always
        });
    } catch (error) {
        console.error('Error en /api/buy-nft:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/mint-payload', async (req, res) => {
    try {
        const { account, title, category, image, royalty, description } = req.body;

        // Construir la URI de metadatos (compatible con IPFS o estándar URI de XRPL)
        const metadataURI = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf4dfuyljbad43rk2q5i4chkuai/" + encodeURIComponent(title);
        const uriHex = Buffer.from(metadataURI).toString('hex').toUpperCase();

        let taxon = 1;
        if (category && category.includes('Stars')) taxon = 2;
        else if (category && category.includes('Botanical')) taxon = 3;
        else if (category && category.includes('Concepts')) taxon = 4;

        const transferFeeVal = Math.round(parseFloat(royalty || 2.5) * 100);

        // Estructura oficial del payload para Xaman (Xumm SDK)
        const payload = {
            txjson: {
                TransactionType: "NFTokenMint",
                Account: account,             // Cuenta del usuario conectado en Xaman
                NFTokenTaxon: taxon,
                Flags: 8,                     // tfTransferable (Permite reventa en el marketplace)
                URI: uriHex,
                TransferFee: transferFeeVal
            }
        };

        // Crear el payload oficial en la API de Xaman
        const xummResponse = await xumm.payload.create(payload);

        if (!xummResponse || !xummResponse.uuid) {
            return res.status(500).json({ success: false, error: 'No se pudo generar el payload en Xaman' });
        }

        res.json({
            success: true,
            uuid: xummResponse.uuid,
            qr_code: xummResponse.refs.qr_png,         // Referencia oficial del QR de Xaman
            deep_link: xummResponse.next.always       // Enlace profundo para abrir la app móvil
        });

    } catch (error) {
        console.error('Error al crear payload NFTokenMint:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// RUTA 1: Crear oferta para comprar un NFT de la tienda Génesis
app.post('/api/buy-nft-offer', async (req, res) => {
    try {
        const { buyerAccount, nftokenId, priceXRP, ownerAccount } = req.body;

        // Validar que los campos críticos no sean nulos o placeholders inválidos
        if (!ownerAccount || ownerAccount.includes('...')) {
            return res.status(400).json({ success: false, error: "La dirección del dueño (Owner) del NFT no es válida o es un marcador de posición." });
        }

        const amountInDrops = (parseFloat(priceXRP) * 1000000).toString();

        const payload = {
            txjson: {
                TransactionType: "NFTokenCreateOffer",
                Account: buyerAccount,
                NFTokenID: nftokenId,
                Amount: amountInDrops,
                Owner: ownerAccount, // Debe ser una cuenta 'r...' real
                Flags: 0 // 0 para Buy Offer (Compra)
            }
        };

        const xummResponse = await xumm.payload.create(payload);

        // Validar si Xaman respondió correctamente
        if (!xummResponse || !xummResponse.uuid) {
            console.error('Respuesta vacía de Xaman:', xummResponse);
            return res.status(400).json({ success: false, error: "Xaman rechazó la creación del payload. Revisa los datos del NFT." });
        }

        res.json({
            success: true,
            uuid: xummResponse.uuid,
            qr_code: xummResponse.refs.qr_png,
            deep_link: xummResponse.next.always
        });
    } catch (error) {
        console.error('Error detallado en buy-nft-offer:', error);
        res.status(500).json({ success: false, error: error.message || error.toString() });
    }
});

// RUTA 2: Crear oferta de venta cuando un usuario enlista su propio NFT (List Your NFT)
app.post('/api/list-nft-offer', async (req, res) => {
    try {
        const { sellerAccount, nftokenId, priceXRP } = req.body;

        const amountInDrops = (parseFloat(priceXRP) * 1000000).toString();

        const payload = {
            txjson: {
                TransactionType: "NFTokenCreateOffer",
                Account: sellerAccount, // Tu cuenta que posee el NFT
                NFTokenID: nftokenId,
                Amount: amountInDrops,
                Flags: 1 // Flag 1 = tfSellNFToken (Oferta de Venta - No requiere campo Owner)
            }
        };

        const xummResponse = await xumm.payload.create(payload);

        if (!xummResponse || !xummResponse.uuid) {
            return res.status(400).json({ success: false, error: "Xaman rechazó la creación de la oferta de venta." });
        }

        res.json({
            success: true,
            uuid: xummResponse.uuid,
            qr_code: xummResponse.refs.qr_png,
            deep_link: xummResponse.next.always
        });
    } catch (error) {
        console.error('Error al enlistar NFT:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// --- Otras rutas existentes en tu backend ---
app.post('/api/list-nft-offer', async (req, res) => {
    // ... tu código existente de listado ...
});

app.post('/api/buy-nft-offer', async (req, res) => {
    // ... tu código existente de compra ...
});

// >>> PEGA AQUÍ EL NUEVO ENDPOINT DE CANCELACIÓN <<<
app.post('/api/cancel-nft-offer', async (req, res) => {
    try {
        const { sellerAccount, nftokenId } = req.body;

        if (!sellerAccount || !nftokenId) {
            return res.status(400).json({ error: 'Faltan parámetros: sellerAccount y nftokenId son obligatorios' });
        }

        // Crear el payload en Xaman para NFTokenCancelOffer
        const payload = {
            TransactionType: 'NFTokenCancelOffer',
            Account: sellerAccount,
            NFTokenOffers: [nftokenId] // ID de la oferta de venta a cancelar en la blockchain
        };

        const response = await xumm.payload.create(payload);
        
        if (response && response.uuid) {
            return res.json({
                uuid: response.uuid,
                qr_code: response.refs.qr_png,
                deep_link: response.next.always
            });
        } else {
            return res.status(500).json({ error: 'No se pudo generar el payload en Xaman' });
        }
    } catch (error) {
        console.error('Error en /api/cancel-nft-offer:', error);
        res.status(500).json({ error: error.message || 'Error interno del servidor' });
    }
});

// 4. Endpoint para verificar el estado de la firma en Xaman
app.get('/api/check-status/:uuid', async (req, res) => {
    try {
        const uuid = req.params.uuid;
        const payloadInfo = await Sdk.payload.get(uuid);

        if (!payloadInfo) {
            return res.status(404).json({ error: 'Payload no encontrado' });
        }

        const signed = payloadInfo.meta.signed;
        const expired = payloadInfo.meta.expired;
        const account = payloadInfo.response.account;

        if (signed) {
            activePayloads[uuid] = {
                signed: true,
                account: account,
                expired: false
            };

            const isAdmin = (account === TREASURY_ADDRESS);

            return res.json({
                signed: true,
                expired: false,
                account: account,
                isAdmin: isAdmin
            });
        }

        if (expired) {
            return res.json({ signed: false, expired: true });
        }

        res.json({ signed: false, expired: false });
    } catch (error) {
        console.error('Error verificando estado:', error);
        res.status(500).json({ error: error.message });
    }
});

// 5. Endpoint para procesar el minteo automático XLS-20 desde la web (Mainnet)
app.post('/api/mint-nft', async (req, res) => {
    try {
        const { title, price, category, image, video, license, description, royalty } = req.body;
        
        const metadataURI = "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf4dfuyljbad43rk2q5i4chkuai/" + encodeURIComponent(title);

        const client = new xrpl.Client('wss://xrplcluster.com');
        await client.connect();

        const mintingWallet = xrpl.Wallet.fromSeed(MINTING_SECRET);
        const transferFeeVal = Math.round(parseFloat(royalty) * 100);

        let taxon = 1;
        if (category.includes('Zodiac')) taxon = 2;
        else if (category.includes('Botanical')) taxon = 3;
        else if (category.includes('Universal')) taxon = 4;

        const mintTx = {
            TransactionType: "NFTokenMint",
            Account: mintingWallet.classicAddress,
            NFTokenTaxon: taxon,
            Flags: 8, // tfTransferable
            URI: xrpl.convertStringToHex(metadataURI),
            TransferFee: transferFeeVal
        };

        const result = await client.submitAndWait(mintTx, { wallet: mintingWallet });
        await client.disconnect();

        res.json({ 
            success: true, 
            message: 'NFT minted successfully on XRPL',
            txHash: result.result.hash,
            issuer: mintingWallet.classicAddress
        });

    } catch (error) {
        console.error('Error during automatic minting:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor de Aeterna Ledger corriendo en http://localhost:${PORT}`);
});
