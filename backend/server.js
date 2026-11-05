const express = require('express');
const cors = require('cors');
const { XummSdk } = require('xumm-sdk');
const xrpl = require('xrpl');
require('dotenv').config();

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
