/**
 * ON Sistema de Inventario — Main application server
 *
 * Express app that drives the RFID garment-tracking system.
 * Connects to MongoDB Atlas ("on" database) and exposes REST
 * endpoints consumed by the EJS frontend.
 *
 * Collections used:
 *   tags        — one document per physical EPC tag
 *   recoleccion — pickup transaction records
 *   entrega     — delivery transaction records
 *   clientes    — client master records (holds references to above)
 *   damage      — damage reports with Cloudinary image URLs
 *   defects     — legacy defect records
 */

// ── External packages ────────────────────────────────────────────────────────
const express = require('express');
const bodyParser = require('body-parser');
const { MongoClient } = require('mongodb');
require('dotenv').config();
const uri = process.env.MONGO_LINK;
var accountSid = process.env.TWILIO_ACCOUNT_SID;
var authToken = process.env.TWILIO_AUTH_TOKEN;

const mongoose = require('mongoose');
const session = require('express-session');
const crypto = require('crypto');
const cron = require('node-cron');

const cloudinary = require('cloudinary').v2;

const { Readable } = require('stream');

const twilioClient = require('twilio')(accountSid, authToken);
const multer = require('multer');

// ── Auth helpers ─────────────────────────────────────────────────────────────
const SUMMARY_SECRET = process.env.SUMMARY_SECRET || 'on-summary-secret-2026';

function genSummaryToken(clientName) {
    return crypto.createHmac('sha256', SUMMARY_SECRET)
        .update(clientName.toLowerCase().trim())
        .digest('hex').slice(0, 16);
}

function verifySummaryToken(clientName, token) {
    return genSummaryToken(clientName) === token;
}


const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB limit – adjust if needed
});

const mongoClient = new MongoClient(uri);
var accountSid = process.env.TWILIO_ACCOUNT_SID;
var authToken = process.env.TWILIO_AUTH_TOKEN;
// Start the webapp
const webApp = express();


const DamageReport = new mongoose.Schema({
    epc: {
        type: String,
        required: true,
        trim: true,
    },
    description: {
        type: String,
        required: true,
        trim: true,
    },
    imageUrl: {
        type: String,
        required: true,
    },
    imagePublicId: { // útil para borrar la imagen más tarde si es necesario
        type: String,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

// config/cloudinary.js

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});


webApp.set('views', './views');
webApp.set('view engine', 'ejs');

// ── Session & auth ───────────────────────────────────────────────────────────
webApp.use(session({
    secret: process.env.SESSION_SECRET || 'on-sistema-session-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));

// Paths that do NOT require authentication
const PUBLIC_PATHS = ['/login', '/logout', '/summary', '/api'];

webApp.use((req, res, next) => {
    const isPublic = PUBLIC_PATHS.some(p => req.path === p || req.path.startsWith(p + '/') || req.path.startsWith(p + '?'));
    if (isPublic || req.session?.authenticated) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'No autorizado' });
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
});

webApp.use(bodyParser.urlencoded({ extended: true }));
webApp.use(bodyParser.json());

// Server Port
const PORT = process.env.PORT;

// ── Login / logout ───────────────────────────────────────────────────────────
webApp.get('/login', (req, res) => {
    if (req.session?.authenticated) return res.redirect(req.query.next || '/');
    res.render('login', { error: null, next: req.query.next || '/' });
});

webApp.post('/login', (req, res) => {
    const { password, next } = req.body;
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
    if (password === ADMIN_PASSWORD) {
        req.session.authenticated = true;
        return res.redirect(next || '/');
    }
    res.render('login', { error: 'Contraseña incorrecta.', next: next || '/' });
});

webApp.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

// JSON login for Android/mobile clients
webApp.post('/api/login', (req, res) => {
    const { password } = req.body;
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
    if (password === ADMIN_PASSWORD) {
        req.session.authenticated = true;
        return res.json({ success: true });
    }
    res.status(401).json({ success: false, message: 'Contraseña incorrecta' });
});

// ── Home route ───────────────────────────────────────────────────────────────
webApp.get('/', (req, res) => {
    res.render('ui');
});

const WA = require('../helper-function/whatsapp-send-message');

// Route for WhatsApp 
// Function to send message to WhatsApp
// Unified sendMessage: handles strings, arrays, or objects
// ──────────────────────────────────────────────────────────────
// Unified sendMessage – handles strings OR full result objects
// ──────────────────────────────────────────────────────────────

/**
 * Converts array of { epc, result: { article, client } } into:
 * "7 toalla from club contry\n2 mantel from club misiones"
 */
/**
 * Converts an array of `{ epc, result: { article, client } }` objects
 * (returned by /conteo_input lookups) into a human-readable summary string.
 *
 * @param {Array<{epc:string, result:{article:string,client:string}}>} dbResults
 * @returns {string} Multi-line summary, e.g. "Se contaron 7 toallas de Club Country"
 */
const buildArticleSummary = (dbResults) => {
    const summary = {};

    for (const item of dbResults) {
        const { client, article } = item.result || {};
        if (!client || !article) continue; // skip malformed

        if (!summary[client]) summary[client] = {};
        summary[client][article] = (summary[client][article] || 0) + 1;
    }

    const lines = [];
    for (const [client, articles] of Object.entries(summary)) {
        for (const [article, count] of Object.entries(articles)) {
            const plural = count > 1 ? 's' : '';
            lines.push(`Se contaron ${count} ${article}${plural} de ${client}`);
        }
    }

    return lines.length > 0 ? lines.join('\n') : 'No results to show.';
};

/**
 * Sends a WhatsApp message via Twilio.
 * Handles three content shapes:
 *   1. Plain string  → sent as-is
 *   2. Array / single object with { client, articles, date } → formatted summary
 *   3. Anything else → JSON chunked into ≤1500-char messages
 *
 * @param {string|object|Array} content - Message payload
 * @param {string} senderID             - Destination phone number (e.g. "+521...")
 * @param {'entrega'|'recoleccion'} accion - Operation type, used to prefix the message
 * @param {{fullJson?: boolean}} [options]
 */
const sendMessage = async (content, senderID, accion, options = {}) => {
    console.log(content);
    console.log('sendMessage → to:', senderID);

    try {
        // 1. Handle plain string
        if (typeof content === 'string') {
            if (!content.trim()) {
                console.warn('Empty string – skipping.');
                return;
            }

            const msg = await twilioClient.messages.create({
                from: 'whatsapp:+14155238886',
                to: 'whatsapp:' + senderID,
                body: content
            });
            console.log('String message sent, SID:', msg.sid);
            return;
        }

        // ───── NEW: Normalize single object → treat as 1-item array ─────
        let items = content;
        if (!Array.isArray(content)) {
            if (content && typeof content === 'object' && content.client && content.articles) {
                items = [content];  // wrap single object in array
            } else {
                // unknown shape → fall back to JSON
                items = null;
            }
        }

        // ───── 2. Handle Array (or normalized single item) ─────
        if (Array.isArray(items) && items.length > 0) {
            // Option to force full JSON (debug)
            if (options.fullJson) {
                return await sendMessage(JSON.stringify(content, null, 2), senderID);
            }

            const first = items[0];
            const client = first.client || 'Cliente desconocido';

            // Format date + time (Mexico-friendly, 24h)
            let dateTimeStr = 'Sin fecha/hora';
            if (first.date) {
                const d = new Date(first.date);

                // "14 feb 2026 17:45"   (adjust locale if needed)
                dateTimeStr = d.toLocaleDateString('es-MX', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                    timeZone: 'America/Monterrey'
                }).replace(/\./g, '') + ' ' +
                    d.toLocaleTimeString('es-MX', {
                        hour: 'numeric',
                        minute: '2-digit',
                        hour12: false,
                        timeZone: 'America/Monterrey'
                    });
            }

            const allArts     = first.articles  || {};
            const rfidArts    = first.rfid_articles;  // present when mixed manual+rfid
            const hasManualOnly = rfidArts &&
                Object.keys(allArts).some(k => !(k in rfidArts));

            const accionEmoji = accion === 'entrega' ? '📦' : '↩';
            const accionLabel = accion === 'entrega' ? 'Entrega' : 'Recolección';

            let body;

            if (hasManualOnly) {
                // ── Split message: conteo RFID + remisión digital ──────────
                const rfidLines  = Object.entries(rfidArts)
                    .map(([t, q]) => `• ${q}  ${t}`).join('\n');
                const rfidTotal  = Object.values(rfidArts)
                    .reduce((s, v) => s + (Number(v) || 0), 0);

                let allTotal = 0;
                const allLines = Object.entries(allArts)
                    .map(([t, q]) => { allTotal += Number(q) || 0; return `• ${q}  ${t}`; })
                    .join('\n');

                body = `*${accionEmoji} Conteo de ${accionLabel}* — ${client}\n${dateTimeStr}\n\n${rfidLines || '_(sin artículos RFID)_'}\n\n_${rfidTotal} prenda${rfidTotal !== 1 ? 's' : ''} con RFID_\n\n━━━━━━━━━━━\n*📋 Remisión digital*\n\n${allLines}\n\n_${allTotal} prenda${allTotal !== 1 ? 's' : ''} en total_`;
            } else {
                // ── Standard single-block message ──────────────────────────
                let totalItems = 0;
                const articleParts = [];
                for (const item of items) {
                    if (item.articles && typeof item.articles === 'object') {
                        for (const [type, qty] of Object.entries(item.articles)) {
                            totalItems += Number(qty) || 0;
                            articleParts.push(`• ${qty}  ${type}`);
                        }
                    }
                }
                const artLines = articleParts.length > 0
                    ? articleParts.join('\n')
                    : `• ${totalItems} artículo${totalItems === 1 ? '' : 's'}`;

                body = `*${accionEmoji} ${accionLabel}* — ${client}\n${dateTimeStr}\n\n${artLines}\n\n_${totalItems} prenda${totalItems === 1 ? '' : 's'} en total_`;
            }

            const msg = await twilioClient.messages.create({
                from: 'whatsapp:+14155238886',
                to: 'whatsapp:' + senderID,
                body
            });
            console.log('Message sent, SID:', msg.sid);

            return;
        }

        // ───── 3. Fallback: everything else → JSON chunked ─────
        const json = JSON.stringify(content, null, 2);
        const lines = json.split('\n');
        const MAX_CHUNK = 1500;

        let chunk = '';
        for (const line of lines) {
            if (chunk.length + line.length + 1 > MAX_CHUNK) {
                await twilioClient.messages.create({
                    from: 'whatsapp:+14155238886',
                    to: 'whatsapp:' + senderID,
                    body: chunk
                });
                console.log('Chunk sent (continued)');
                chunk = line + '\n';
            } else {
                chunk += line + '\n';
            }
        }

        if (chunk.trim()) {
            await twilioClient.messages.create({
                from: 'whatsapp:+14155238886',
                to: 'whatsapp:' + senderID,
                body: chunk
            });
            console.log('Final chunk sent');
        }

    } catch (error) {
        console.error('sendMessage error →', error.message);
        try {
            await twilioClient.messages.create({
                from: 'whatsapp:+14155238886',
                to: 'whatsapp:' + senderID,
                body: 'Error al enviar la respuesta.'
            });
        } catch (fallbackErr) {
            console.error('Fallback message also failed →', fallbackErr.message);
        }
    }
};

/**
 * POST /api/recoleccion
 *
 * Records a pickup (recolección) transaction.
 * For each EPC: updates `tags.last_seen` and `tags.status = "Recoleccion"`,
 * inserts a document in the `recoleccion` collection, and pushes its _id
 * into the matching `clientes.recolecciones` array.
 * Sends a WhatsApp summary to the client's registered number.
 *
 * Body: { timestamp: string, items: { [client]: { [article]: { count, epcs[] } } } }
 */
webApp.post('/api/recoleccion', async (req, res) => {
    try {
        const { timestamp, items, customDate } = req.body;

        if (!items || Object.keys(items).length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No se recibieron ítems para procesar.'
            });
        }

        const recordDate = customDate ? new Date(customDate) : new Date();
        console.log(`Recolección recibida el ${timestamp}${customDate ? ` (fecha retroactiva: ${recordDate.toISOString()})` : ''}`);

        let totalUpdated = 0;
        let totalProcessed = 0;

        const db = mongoClient.db("on");
        const Tags = db.collection("tags");
        const Recoleccion = db.collection("recoleccion");
        const Cliente = db.collection("clientes");
        var client_name = 'name'
        var recoleccion_final = {}

        for (const [client, articles] of Object.entries(items)) {
            console.log(`Cliente: ${client}`);

            const EPCList    = [];
            const things_in  = {};   // all articles (rfid + manual)
            const rfid_things = {};  // only articles that had real EPCs scanned

            for (const [article, data] of Object.entries(articles)) {
                const { count, epcs = [], declared_count } = data;
                totalProcessed += epcs.length;

                // Use declared_count if operator overrode the scanned count
                things_in[article] = declared_count !== undefined ? declared_count : count;
                console.log(`  ${things_in[article]} ${article} (${epcs.length} EPCs escaneados)`);

                for (const epc of epcs) {
                    const trimmedEpc = epc.trim();
                    EPCList.push(trimmedEpc);

                    const updatedTag = await Tags.findOneAndUpdate(
                        { scanId: trimmedEpc },
                        { $set: { last_seen: new Date(), status: "Recoleccion" } },
                        { new: true, upsert: false }
                    );

                    if (updatedTag) {
                        totalUpdated++;
                        console.log(`    ✓ EPC ${trimmedEpc} actualizado`);
                    } else {
                        console.log(`    ⚠ EPC ${trimmedEpc} no encontrado`);
                    }
                }

                if (epcs.length > 0) {
                    // Scanned via RFID → always in conteo
                    rfid_things[article] = things_in[article];
                } else if (things_in[article] > 0) {
                    // Manual entry → check if this article already has tags for this client
                    const existingCount = await Tags.countDocuments({ client, article, isManual: { $ne: true } });
                    if (existingCount > 0) {
                        rfid_things[article] = things_in[article];
                    } else {
                        // Brand-new article — auto-create inventory tags
                        const qty = things_in[article];
                        const now = new Date();
                        const prefix = Date.now().toString(36).toUpperCase();
                        const newTags = Array.from({ length: qty }, (_, i) => ({
                            scanId:    `MAN${prefix}${i.toString(36).padStart(4, '0').toUpperCase()}`,
                            article,
                            client,
                            status:    'Recoleccion',
                            wash_count: 0,
                            damaged:   false,
                            damage:    false,
                            last_seen: now,
                            createdAt: now,
                            isManual:  true,
                        }));
                        const tagInsert = await Tags.insertMany(newTags);
                        const newTagIds = Object.values(tagInsert.insertedIds);
                        await Cliente.updateOne(
                            { name: client },
                            { $push: { tags: { $each: newTagIds } } }
                        );
                        console.log(`  ✓ Auto-created ${qty} manual tags for new article "${article}" (client: ${client})`);
                    }
                }
            }

            // 1. Guardar la recolección y obtener su _id
            const newRecoleccion = {
                articles: things_in,
                rfid_articles: rfid_things,
                client: client,
                date: recordDate,
                EPCs: EPCList,
                manual: EPCList.length === 0,
            };

            recoleccion_final = newRecoleccion
            const insertResult = await Recoleccion.insertOne(newRecoleccion);
            const recoleccionId = insertResult.insertedId;

            console.log(`Recolección guardada → _id: ${recoleccionId}`);

            // 2. Agregar la referencia al array del cliente
            const updateResult = await Cliente.updateOne(
                { name: client },
                {
                    $push: { recolecciones: recoleccionId },   // ← aquí está el cambio principal
                    $set: { last_recoleccion: new Date() }    // opcional - muy útil
                }
            );
            client_name = client
            if (updateResult.matchedCount === 0) {
                console.warn(`Cliente ${client} no encontrado → no se pudo agregar recolección`);
                // Opcional: aquí podrías decidir si crear el cliente o solo loguear
            }
        }
        const final_client_name = await Cliente.findOne({ name: client_name })
        console.log(final_client_name)
        console.log(client_name)

        await sendMessage(recoleccion_final, final_client_name.numero, accion = 'recoleccion')

        console.log(`Resumen: ${totalProcessed} EPCs procesados → ${totalUpdated} actualizados`);

        res.json({
            success: true,
            message: 'Recolección procesada y vinculada al cliente',
            details: {
                timestamp,
                epcsProcessed: totalProcessed,
                tagsUpdated: totalUpdated,
            }
        });

        // Fire-and-forget snapshot — does not block the response
        if (client_name) {
            takeInventorySnapshot(mongoClient.db('on'), client_name)
                .catch(e => console.error('[snapshot] recoleccion error:', e));
        }

    } catch (error) {
        console.error('Error al procesar recolección:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor',
            error: error.message
        });
    }
});

/**
 * POST /api/entrega
 *
 * Records a delivery (entrega) transaction.
 * For each EPC: increments `tags.wash_count`, updates `tags.last_seen` and
 * `tags.status = "Entregado"`, inserts into `entrega` collection, and pushes
 * its _id into `clientes.entregas`.
 * Sends a WhatsApp summary to the client's registered number.
 *
 * Body: { timestamp: string, items: { [client]: { [article]: { count, epcs[] } } } }
 */
webApp.post('/api/entrega', async (req, res) => {
    try {
        const { timestamp, items, customDate } = req.body;

        if (!items || Object.keys(items).length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No se recibieron ítems para procesar.'
            });
        }

        const recordDate = customDate ? new Date(customDate) : new Date();
        console.log(`Entrega recibida el ${timestamp}${customDate ? ` (fecha retroactiva: ${recordDate.toISOString()})` : ''}`);

        let totalUpdated = 0;
        let totalProcessed = 0;

        const db = mongoClient.db("on");
        const Tags = db.collection("tags");
        const Entrega = db.collection("entrega");
        const Cliente = db.collection("clientes");
        var entrega_final = {}
        var cliente_name = "name"

        for (const [client, articles] of Object.entries(items)) {
            console.log(`Cliente: ${client}`);

            const EPCList     = [];
            const things_in   = {};   // all articles (rfid + manual)
            const rfid_things = {};   // only articles that had real EPCs scanned

            for (const [article, data] of Object.entries(articles)) {
                const { count, epcs = [], declared_count } = data;
                totalProcessed += epcs.length;

                // Use declared_count if operator overrode the scanned count
                things_in[article] = declared_count !== undefined ? declared_count : count;
                console.log(`  ${things_in[article]} ${article} (${epcs.length} EPCs escaneados)`);

                for (const epc of epcs) {
                    const trimmedEpc = epc.trim();
                    EPCList.push(trimmedEpc);

                    const updatedTag = await Tags.findOneAndUpdate(
                        { scanId: trimmedEpc },
                        {
                            $inc: { wash_count: 1 },
                            $set: { last_seen: new Date(), status: "Entregado" },
                        },
                        { new: true, upsert: false }
                    );

                    if (updatedTag) {
                        totalUpdated++;
                        console.log(`    ✓ EPC ${trimmedEpc} actualizado → wash_count: ${updatedTag.wash_count}`);
                    } else {
                        console.log(`    ⚠ EPC ${trimmedEpc} no encontrado`);
                    }
                }

                if (epcs.length > 0) {
                    // Scanned via RFID → always in conteo
                    rfid_things[article] = things_in[article];
                } else if (things_in[article] > 0) {
                    // Manual entry → check if this article already has tags for this client
                    const existingCount = await Tags.countDocuments({ client, article, isManual: { $ne: true } });
                    if (existingCount > 0) {
                        rfid_things[article] = things_in[article];
                    } else {
                        // Brand-new article — auto-create inventory tags
                        const qty = things_in[article];
                        const now = new Date();
                        const prefix = Date.now().toString(36).toUpperCase();
                        const newTags = Array.from({ length: qty }, (_, i) => ({
                            scanId:    `MAN${prefix}${i.toString(36).padStart(4, '0').toUpperCase()}`,
                            article,
                            client,
                            status:    'Entregado',
                            wash_count: 1,
                            damaged:   false,
                            damage:    false,
                            last_seen: now,
                            createdAt: now,
                            isManual:  true,
                        }));
                        const tagInsert = await Tags.insertMany(newTags);
                        const newTagIds = Object.values(tagInsert.insertedIds);
                        await Cliente.updateOne(
                            { name: client },
                            { $push: { tags: { $each: newTagIds } } }
                        );
                        console.log(`  ✓ Auto-created ${qty} manual tags for new article "${article}" (client: ${client})`);
                    }
                }
            }

            // 1. Guardar la entrega y obtener su _id
            const newEntrega = {
                articles: things_in,
                rfid_articles: rfid_things,
                client: client,
                date: recordDate,
                EPCs: EPCList,
                manual: EPCList.length === 0,
            };
            entrega_final = newEntrega
            const insertResult = await Entrega.insertOne(newEntrega);
            const entregaId = insertResult.insertedId;

            console.log(`Entrega guardada → _id: ${entregaId}`);
            cliente_name = client
            // 2. Agregar referencia al array del cliente
            const updateResult = await Cliente.updateOne(
                { name: client },
                {
                    $push: { entregas: entregaId },           // ← aquí se agrega el ObjectId
                    $set: { last_entrega: new Date() }       // campo muy útil para ordenar / estadísticas
                    // Opcional: $inc: { total_entregas: 1 }
                }
            );

            if (updateResult.matchedCount === 0) {
                console.warn(`Cliente ${client} no encontrado → no se pudo vincular entrega`);
                // Opcional: aquí podrías crear el cliente o solo registrar el warning
            }
        }
        console.log(cliente_name)
        const final_client_name = await Cliente.findOne({ name: cliente_name })
        console.log(final_client_name)

        await sendMessage(entrega_final, final_client_name.numero, accion = 'entrega')

        console.log(`Resumen: ${totalProcessed} EPCs procesados → ${totalUpdated} actualizados (+1 lavado cada uno)`);

        res.json({
            success: true,
            message: 'Entrega procesada y vinculada al cliente',
            details: {
                timestamp,
                epcsProcessed: totalProcessed,
                tagsUpdated: totalUpdated,
            }
        });

        // Fire-and-forget snapshot — does not block the response
        if (cliente_name) {
            takeInventorySnapshot(mongoClient.db('on'), cliente_name)
                .catch(e => console.error('[snapshot] entrega error:', e));
        }

    } catch (error) {
        console.error('Error al procesar entrega:', error);
        res.status(500).json({
            success: false,
            message: 'Error interno del servidor',
            error: error.message
        });
    }
});

/**
 * POST /api/repro
 *
 * Marks EPCs as reprocessed (reprocesado).
 * For each EPC: sets `tags.status = "Reprocesado"` and updates `tags.last_seen`.
 * Does not create a transaction document or send a WhatsApp message.
 *
 * Body: { timestamp: string, items: { [client]: { [article]: { count, epcs[] } } } }
 */
webApp.post('/api/repro', async (req, res) => {
    try {
        const { timestamp, items } = req.body;

        if (!items || Object.keys(items).length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No se recibieron ítems para procesar.'
            });
        }

        console.log(`Entrega recibida el ${timestamp}`);

        let totalUpdated = 0;
        let totalProcessed = 0;

        const db = mongoClient.db("on");
        const Tags = db.collection("tags");
        const Entrega = db.collection("entrega");
        const Cliente = db.collection("clientes");
        var entrega_final = {}
        var cliente_name = "name"

        for (const [client, articles] of Object.entries(items)) {
            console.log(`Cliente: ${client}`);

            const EPCList = [];
            const things_in = {};   // artículo → cantidad

            for (const [article, data] of Object.entries(articles)) {
                const { count, epcs } = data;
                totalProcessed += epcs.length;

                console.log(`  ${count} ${article}`);
                things_in[article] = count;
                console.log(`  Procesando ${epcs.length} EPCs...`);

                for (const epc of epcs) {
                    const trimmedEpc = epc.trim();
                    EPCList.push(trimmedEpc);

                    const updatedTag = await Tags.findOneAndUpdate(
                        { scanId: trimmedEpc },
                        {
                            $set: { last_seen: new Date() },
                            $set: { status: "Reprocesado" }

                        },
                        { new: true, upsert: false }
                    );

                    if (updatedTag) {
                        totalUpdated++;
                        console.log(`    ✓ EPC ${trimmedEpc} actualizado  a reprocesado`);
                    } else {
                        console.log(`    ⚠ EPC ${trimmedEpc} no encontrado`);
                    }
                }
            }
        }
    } catch (e) {
        console.log(e)
    }
})


/**
 * POST /api/lookup
 *
 * Batch EPC lookup used by the live-counting UI.
 * Validates and deduplicates on both client and server side (defence-in-depth).
 * Returns results in the same order as the input array so the UI can zip them.
 *
 * Body:    { epcs: string[] }
 * Returns: Array<{ epc, found, client?, article? }>
 */
webApp.post('/api/lookup', async (req, res) => {
    try {
        let { epcs } = req.body;

        if (!Array.isArray(epcs)) {
            return res.status(400).json({ error: "epcs debe ser un array" });
        }

        // Last line of defense – filter invalid here too (defense in depth)
        epcs = epcs
            .map(e => String(e).trim().toUpperCase())
            .filter(e => e.length === 24 && /^[0-9A-F]{24}$/i.test(e));

        if (epcs.length === 0) {
            return res.json([]);
        }

        // Remove duplicates on server side too (paranoia + safety)
        epcs = [...new Set(epcs)];

        const docs = await mongoClient.db("on")
            .collection("tags")
            .find({ scanId: { $in: epcs } })
            .project({ scanId: 1, client: 1, article: 1 })
            .toArray();

        const map = new Map(docs.map(d => [d.scanId, {
            found: true,
            client: d.client,
            article: d.article
        }]));

        // Return in same order as input
        const result = epcs.map(epc => map.get(epc) || { epc, found: false });

        res.json(result);

    } catch (err) {
        console.error(err);
        res.status(500).json([]);
    }
});
// ---------- WhatsApp ----------
// ---------- Web Form Input ----------
webApp.post('/conteo_input', async (req, res) => {
    const body = req.body;
    const rawText = body.IDs || '';  // Asegúrate de que el name del textarea sea "IDs"

    console.log('Raw input recibido:', rawText);

    // 1. Separar por saltos de línea
    const lines = rawText.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0);

    // 2. Eliminar duplicados (opcional, pero útil)
    const uniqueEPCs = [...new Set(lines)];

    // 3. Imprimir cada EPC individualmente
    console.log(`\nTotal EPCs recibidos: ${lines.length}`);
    console.log(`EPCs únicos: ${uniqueEPCs.length}\n`);

    uniqueEPCs.forEach((epc, index) => {
        console.log(`${index + 1}. ${epc}`);
    });

    // 4. (Opcional) Buscar en MongoDB y generar resumen
    const results = [];
    for (const epc of uniqueEPCs) {
        try {
            const result = await mongoClient.db("on").collection("tags").findOne({ scanId: epc });
            results.push({ epc, result });
            console.log(`→ ${epc} →`, result ? 'Encontrado' : 'No encontrado');
        } catch (err) {
            console.error(`Error buscando ${epc}:`, err.message);
            results.push({ epc, error: err.message });
        }
    }

    // 5. Generar resumen como en WhatsApp
    const summary = buildArticleSummary(results.filter(r => r.result));

    // 6. Responder en la web
    res.send(`
        <div style="font-family: 'Poppins', sans-serif; padding: 40px; text-align: center; background: #f0f7f4; min-height: 100vh;">
            <h1 style="color: #128C7E;">Conteo Procesado</h1>
            <p><strong>${uniqueEPCs.length}</strong> EPCs únicos procesados.</p>
            <pre style="background: white; padding: 16px; border-radius: 12px; text-align: left; max-width: 600px; margin: 20px auto; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
${summary}
            </pre>
            <a href="/" style="background: #25D366; color: white; padding: 12px 24px; border-radius: 12px; text-decoration: none; font-weight: 600;">Volver al inicio</a>
        </div>
    `);
});

webApp.post('/create_defect', async (req, res) => {
    const body = req.body

    try {
        await createDefect(client, {
            defect_count: 1,
            descripcion: [req.body.descripcion],
            image: [req.body.image],
            scanId: epc
        });
        console.log(`${i + 1}. ${epc} → inserted`);
    } catch (err) {
        console.error(`${i + 1}. ${epc} → FAILED:`, err.message);
    }
})

webApp.get('/create_defect', async (req, res) => {
    res.render('document_damage')
})


/**
 * Inserts a defect record into the `defects` collection.
 * @param {MongoClient} client - Unused parameter (uses module-level mongoClient instead)
 * @param {{ defect_count, descripcion, image, scanId }} newTag
 */
async function createDefect(client, newTag) {
    const result = await mongoClient.db("on").collection("defects").insertOne(newTag);
    console.log(`New tag created with _id: ${result.insertedId}`);
}

/**
 * POST /api/conteo-bodega
 *
 * Marks EPCs as inventoried in the warehouse ("Conteo de Bodega").
 * Updates `tags.status` and `tags.last_seen` without creating a transaction
 * document — this is a lightweight status-only update.
 *
 * Body:    { epcs: string[] }
 * Returns: { success: true, updated: number }
 */
webApp.post('/api/conteo-bodega', async (req, res) => {
    try {
        let { epcs } = req.body;
        if (!Array.isArray(epcs) || epcs.length === 0) {
            return res.status(400).json({ error: 'epcs debe ser un array no vacío' });
        }

        epcs = epcs
            .map(e => String(e).trim().toUpperCase())
            .filter(e => e.length === 24 && /^[0-9A-F]{24}$/i.test(e));

        let totalUpdated = 0;
        for (const epc of epcs) {
            const result = await mongoClient.db("on").collection("tags").updateOne(
                { scanId: epc },
                { $set: { status: "Conteo de Bodega", last_seen: Date.now() } }
            );
            if (result.modifiedCount > 0) totalUpdated++;
        }

        res.json({ success: true, updated: totalUpdated });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

// ── Dar de Alta ──────────────────────────────────────────────────────────────

/** GET /dar-de-alta — renders the "dar de alta" registration page */
webApp.get('/dar-de-alta', (req, res) => {
    res.render('dar_de_alta');
});

/**
 * POST /api/dar-de-alta
 *
 * Registers new EPC tags in the system (high-volume initial load).
 * For each EPC this endpoint:
 *   1. Validates the 24-char hex format
 *   2. Skips duplicates (scanId already in tags collection)
 *   3. Inserts a new tag document with status "Sin actualizacion"
 *   4. Adds the tag _id to the matching client's `tags` array,
 *      or creates a new client document if one doesn't exist yet
 *
 * Body:    { epcs: string[], articulo: string, cliente: string }
 * Returns: { success, inserted, skipped_duplicate, skipped_invalid }
 */
webApp.post('/api/dar-de-alta', async (req, res) => {
    try {
        let { epcs, articulo, cliente } = req.body;

        if (!Array.isArray(epcs) || epcs.length === 0) {
            return res.status(400).json({ error: 'epcs debe ser un array no vacío' });
        }
        if (!articulo?.trim() || !cliente?.trim()) {
            return res.status(400).json({ error: 'articulo y cliente son requeridos' });
        }

        const db = mongoClient.db("on");
        const results = { inserted: 0, updated: 0, skipped_duplicate: 0, skipped_invalid: 0 };

        for (const epc of epcs) {
            const trimmedEpc = String(epc).trim().toUpperCase();

            if (trimmedEpc.length !== 24 || !/^[0-9A-F]{24}$/i.test(trimmedEpc)) {
                results.skipped_invalid++;
                continue;
            }

            const existingTag = await db.collection("tags").findOne({ scanId: trimmedEpc });
            if (existingTag) {
                // Exact same article + client → true duplicate, nothing to do
                if (existingTag.article === articulo.trim() && existingTag.client === cliente.trim()) {
                    results.skipped_duplicate++;
                    continue;
                }

                // Article or client changed → update the tag
                const oldClient = existingTag.client;
                const newClient = cliente.trim();

                await db.collection("tags").updateOne(
                    { scanId: trimmedEpc },
                    { $set: { article: articulo.trim(), client: newClient, last_seen: Date.now() } }
                );

                // If the client changed, move the tag reference between client documents
                if (oldClient !== newClient) {
                    await db.collection("clientes").updateOne(
                        { name: oldClient },
                        { $pull: { tags: existingTag._id } }
                    );
                    const newClientDoc = await db.collection("clientes").findOne({ name: newClient });
                    if (newClientDoc) {
                        await db.collection("clientes").updateOne(
                            { _id: newClientDoc._id },
                            { $addToSet: { tags: existingTag._id } }
                        );
                    } else {
                        await db.collection("clientes").insertOne({
                            name: newClient,
                            recolecciones: [],
                            entregas: [],
                            numero: "+15129654086",
                            tags: [existingTag._id]
                        });
                    }
                }

                results.updated++;
                continue;
            }

            const tagResult = await db.collection("tags").insertOne({
                article: articulo.trim(),
                client: cliente.trim(),
                status: "Sin actualizacion",
                wash_count: 0,
                last_seen: Date.now(),
                scanId: trimmedEpc,
                damage: false
            });

            const tagId = tagResult.insertedId;

            const existingClient = await db.collection("clientes").findOne({ name: cliente.trim() });
            if (existingClient) {
                await db.collection("clientes").updateOne(
                    { _id: existingClient._id },
                    { $push: { tags: tagId } }
                );
            } else {
                await db.collection("clientes").insertOne({
                    name: cliente.trim(),
                    recolecciones: [],
                    entregas: [],
                    numero: "+15129654086",
                    tags: [tagId]
                });
            }

            results.inserted++;
        }

        res.json({ success: true, ...results });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

// Start the server
webApp.listen(PORT, () => {
    console.log(`Server is up and running at ${PORT}`);
});


webApp.post('/report-damage', upload.single('photo'), async (req, res) => {
    try {
        const { unitId: epc, description } = req.body;

        if (!epc?.trim() || !description?.trim()) {
            return res.status(400).json({
                error: 'El ID de la unidad y la descripción son obligatorios.',
            });
        }

        if (!req.file) {
            return res.status(400).json({
                error: 'Debes subir una foto del daño.',
            });
        }

        const trimmedEpc = epc.trim();

        // 1. Find tag to get client (optional)
        let clientName = null;
        const tag = await mongoClient.db("on")
            .collection("tags")
            .findOne({ scanId: trimmedEpc });

        if (tag) {
            clientName = tag.client || null;

            // Mark as damaged
            await mongoClient.db("on")
                .collection("tags")
                .updateOne(
                    { scanId: trimmedEpc },
                    { $set: { damaged: true } }
                );
            console.log(`Tag ${trimmedEpc} marcado como dañado`);
        }

        // 2. Upload to Cloudinary using stream
        const uploadResult = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                {
                    folder: 'damage-reports',
                    allowed_formats: ['jpeg', 'jpg', 'png', 'gif', 'webp'],
                    transformation: [
                        { width: 800, height: 800, crop: 'limit' },
                        { quality: 'auto:good' },
                        { fetch_format: 'auto' },
                    ],
                    public_id: `damage-${Date.now()}-${Math.round(Math.random() * 1e9)}`,
                },
                (error, result) => {
                    if (error) return reject(error);
                    resolve(result);
                }
            );

            Readable.from(req.file.buffer).pipe(stream);
        });

        // 3. Save report
        const newDamageReport = {
            epc: trimmedEpc,
            description: description.trim(),
            client: clientName,
            date: new Date(),
            imageUrl: uploadResult.secure_url,
            imagePublicId: uploadResult.public_id,
        };

        await mongoClient.db("on").collection("damage").insertOne(newDamageReport);
        console.log('Reporte de daño creado:', newDamageReport);

        res.redirect('/?damageReported=true');

    } catch (error) {
        console.error('Error al crear reporte de daño:', error);
        res.status(500).json({
            error: 'Error interno del servidor al subir la imagen o guardar el reporte.',
        });
    }
});

webApp.post('/dashboard', async (req, res) => {
    const { client } = req.body;  // ← Change back to "client" to match the form

    let clientName = null;
    let stats = null;
    let articleAverages = null;
    let error = null;
    let overallAverage = '0';
    let damagedColor = '#4caf50';
    let currentlyOut = 0;
    let returnRate = null;
    let lifecycleAlerts = [];
    let thresholds = {};
    let recentEntregas = [];

    if (!client?.trim()) {
        error = 'Por favor ingresa un nombre de cliente.';
    } else {
        clientName = client.trim();

        try {
            const tagsCollection = await mongoClient.db("on").collection("tags");

            // General stats
            const generalStats = await tagsCollection.aggregate([
                { $match: { client: clientName } },
                {
                    $group: {
                        _id: null,
                        totalItems: { $sum: 1 },
                        totalWashCount: { $sum: "$wash_count" },
                        damagedCount: {
                            $sum: { $cond: [{ $eq: ["$damaged", true] }, 1, 0] }
                        }
                    }
                }
            ]).toArray();

            stats = generalStats.length > 0 ? generalStats[0] : {
                totalItems: 0,
                totalWashCount: 0,
                damagedCount: 0
            };

            // Per-article averages
            articleAverages = await tagsCollection.aggregate([
                { $match: { client: clientName } },
                {
                    $group: {
                        _id: "$article",
                        itemCount: { $sum: 1 },
                        totalWashes: { $sum: "$wash_count" },
                        avgWashes: { $avg: "$wash_count" }
                    }
                },
                { $sort: { avgWashes: -1 } }
            ]).toArray();

            // Calculate derived values
            overallAverage = stats.totalItems > 0
                ? (stats.totalWashCount / stats.totalItems).toFixed(1)
                : '0';
            damagedColor = stats.damagedCount > 0 ? '#d32f2f' : '#4caf50';

            // Currently out (tags whose status is "Recoleccion")
            currentlyOut = await tagsCollection.countDocuments({ client: clientName, status: 'Recoleccion' });

            // Return rate over last 30 days
            const thirty = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const [recCount30, entCount30] = await Promise.all([
                mongoClient.db("on").collection("recoleccion").countDocuments({ client: clientName, date: { $gte: thirty } }),
                mongoClient.db("on").collection("entrega").countDocuments({ client: clientName, date: { $gte: thirty } })
            ]);
            returnRate = recCount30 > 0 ? Math.round((entCount30 / recCount30) * 100) : null;

            // Lifecycle alerts — articles at or near their wash threshold
            const clientDoc = await mongoClient.db("on").collection("clientes").findOne({ name: clientName });
            const savedThresholds = clientDoc?.thresholds || {};
            const DEFAULT_THRESHOLD = 80;

            lifecycleAlerts = (articleAverages || [])
                .map(a => {
                    const threshold = savedThresholds[a._id] || DEFAULT_THRESHOLD;
                    const pct = Math.round(((a.avgWashes || 0) / threshold) * 100);
                    return { article: a._id, avgWashes: (a.avgWashes || 0).toFixed(1), threshold, pct, critical: pct >= 100, warning: pct >= 80 };
                })
                .filter(a => a.warning)
                .sort((a, b) => b.pct - a.pct);

            thresholds = savedThresholds;

            // Recent entrega activity — shown when client has no RFID tags (manual-only)
            recentEntregas = await mongoClient.db("on").collection("entrega")
                .find({ client: clientName })
                .sort({ date: -1 })
                .limit(5)
                .toArray();

        } catch (err) {
            console.error('Error en dashboard:', err);
            error = 'Error al consultar la base de datos.';
        }
    }

    res.render('dashboard', {
        client: clientName,
        stats,
        articleAverages,
        error,
        overallAverage,
        damagedColor,
        currentlyOut: currentlyOut || 0,
        returnRate,
        lifecycleAlerts,
        thresholds,
        recentEntregas,
        summaryToken: clientName ? genSummaryToken(clientName) : null
    });
});

// GET /damage-breakdown?client=Club Country
webApp.get('/damage-breakdown', async (req, res) => {
    const clientName = req.query.client?.trim() || null;

    if (!clientName) {
        return res.redirect('/dashboard');
    }

    try {
        const damageCollection = mongoClient.db("on").collection("damage");
        const tagsCollection = mongoClient.db("on").collection("tags");

        // Fetch all damage reports for this client
        const damageReports = await damageCollection
            .find({ client: clientName })
            .sort({ date: -1 })
            .toArray();

        // Total damaged items
        const totalDamaged = damageReports.length;

        // Breakdown by article
        const articleBreakdown = {};
        const epcList = damageReports.map(report => report.epc);

        if (epcList.length > 0) {
            const tags = await tagsCollection
                .find({ scanId: { $in: epcList } })
                .project({ scanId: 1, article: 1 })
                .toArray();

            const tagMap = new Map(tags.map(t => [t.scanId, t.article]));

            damageReports.forEach(report => {
                const article = tagMap.get(report.epc) || 'Artículo Desconocido';
                articleBreakdown[article] = (articleBreakdown[article] || 0) + 1;
            });
        }

        // Sort breakdown by count descending
        const sortedBreakdown = Object.entries(articleBreakdown)
            .sort((a, b) => b[1] - a[1]);

        res.render('damage_breakdown', {
            client: clientName,
            totalDamaged,
            articleBreakdown: sortedBreakdown,
            damageReports,
            error: null
        });

    } catch (err) {
        console.error('Error en damage-breakdown:', err);
        res.render('damage_breakdown', {
            client: clientName,
            totalDamaged: 0,
            articleBreakdown: [],
            damageReports: [],
            error: 'Error al cargar el desglose de daños.'
        });
    }
});

webApp.get('/log', async (req, res) => {
    const clientName = req.query.client?.trim() || null;

    if (!clientName) {
        return res.redirect('/dashboard');
    }

    try {
        const recoleccionCollection = mongoClient.db("on").collection("recoleccion");
        const entregaCollection = mongoClient.db("on").collection("entrega");

        // Fetch all recolecciones and entregas for this client
        const recolecciones = await recoleccionCollection
            .find({ client: clientName })
            .sort({ date: -1 })
            .toArray();

        const entregas = await entregaCollection
            .find({ client: clientName })
            .sort({ date: -1 })
            .toArray();

        // === INSERT THE SAFE CODE HERE ===
        // Safe way to sum article counts
        const safeSumArticles = (articles) => {
            if (!articles || typeof articles !== 'object') return 0;
            return Object.values(articles)
                .reduce((acc, val) => acc + (typeof val === 'number' ? val : 0), 0);
        };

        const totalPrendasRecogidas = recolecciones.reduce((sum, r) =>
            sum + safeSumArticles(r.articles), 0);

        const totalPrendasEntregadas = entregas.reduce((sum, e) =>
            sum + safeSumArticles(e.articles), 0);
        // === END OF INSERTION ===

        // Combine and sort all events by date (newest first)
        const allEvents = [
            ...recolecciones.map(e => ({ ...e, type: 'recoleccion', typeLabel: 'Recolección' })),
            ...entregas.map(e => ({ ...e, type: 'entrega', typeLabel: 'Entrega' }))
        ].sort((a, b) => new Date(b.date) - new Date(a.date));

        // Summary stats (non-article counts remain the same)
        const totalRecolecciones = recolecciones.length;
        const totalEntregas = entregas.length;

        res.render('log', {
            client: clientName,
            allEvents,
            totalRecolecciones,
            totalEntregas,
            totalPrendasRecogidas,
            totalPrendasEntregadas,
            error: null
        });

    } catch (err) {
        console.error('Error en bitácora:', err);
        res.render('log', {
            client: clientName,
            allEvents: [],
            totalRecolecciones: 0,
            totalEntregas: 0,
            totalPrendasRecogidas: 0,
            totalPrendasEntregadas: 0,
            error: 'Error al cargar la bitácora de recolección y entrega.'
        });
    }
});

/**
 * GET /api/log?client=X  — JSON version of the bitácora for the Android app
 */
webApp.get('/api/log', async (req, res) => {
    const clientName = req.query.client?.trim();
    if (!clientName) return res.status(400).json({ error: 'client param required' });
    try {
        const db = mongoClient.db('on');
        const safeSumArticles = (articles) => {
            if (!articles || typeof articles !== 'object') return 0;
            return Object.values(articles).reduce((acc, val) => acc + (typeof val === 'number' ? val : 0), 0);
        };
        const [recolecciones, entregas] = await Promise.all([
            db.collection('recoleccion').find({ client: clientName }).sort({ date: -1 }).toArray(),
            db.collection('entrega').find({ client: clientName }).sort({ date: -1 }).toArray(),
        ]);
        const toEvent = (doc, type) => ({
            type,
            date: doc.date instanceof Date ? doc.date.toISOString() : String(doc.date),
            articles: doc.articles && typeof doc.articles === 'object' ? doc.articles : {},
            totalItems: safeSumArticles(doc.articles),
        });
        const events = [
            ...recolecciones.map(d => toEvent(d, 'recoleccion')),
            ...entregas.map(d => toEvent(d, 'entrega')),
        ].sort((a, b) => new Date(b.date) - new Date(a.date));
        res.json({
            events,
            totalRecolecciones: recolecciones.length,
            totalEntregas: entregas.length,
            totalPrendasRecogidas: recolecciones.reduce((s, r) => s + safeSumArticles(r.articles), 0),
            totalPrendasEntregadas: entregas.reduce((s, e) => s + safeSumArticles(e.articles), 0),
        });
    } catch (err) {
        console.error('/api/log error:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/analytics?client=X
 *
 * Returns aggregated analytics data used by Chart.js on the dashboard and bitácora pages.
 * Covers: daily delivery counts per article, monthly recoleccion/entrega activity,
 * current tag status breakdown, and "currently out" count.
 */
webApp.get('/api/analytics', async (req, res) => {
    const clientName = req.query.client?.trim();
    if (!clientName) return res.status(400).json({ error: 'client param required' });

    try {
        const db = mongoClient.db("on");
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const [entregas, recolecciones, tags, recentEntregas] = await Promise.all([
            db.collection('entrega').find({ client: clientName }).sort({ date: 1 }).toArray(),
            db.collection('recoleccion').find({ client: clientName }).sort({ date: 1 }).toArray(),
            db.collection('tags').find({ client: clientName }, { projection: { status: 1, article: 1, wash_count: 1, damaged: 1 } }).toArray(),
            db.collection('entrega').find({ client: clientName, date: { $gte: thirtyDaysAgo } }).toArray(),
        ]);

        // Status breakdown and article discovery from tags
        const statusBreakdown = {};
        const articleSet = new Set();
        for (const tag of tags) {
            const s = tag.status || 'Sin actualizacion';
            statusBreakdown[s] = (statusBreakdown[s] || 0) + 1;
            if (tag.article) articleSet.add(tag.article);
        }

        // Daily delivery counts per article (from entrega docs)
        const dailyMap = {};
        for (const e of entregas) {
            const day = new Date(e.date).toISOString().slice(0, 10);
            if (!dailyMap[day]) dailyMap[day] = {};
            for (const [article, count] of Object.entries(e.articles || {})) {
                articleSet.add(article);
                dailyMap[day][article] = (dailyMap[day][article] || 0) + Number(count);
            }
        }

        // Monthly transaction counts
        const monthlyMap = {};
        for (const r of recolecciones) {
            const m = new Date(r.date).toISOString().slice(0, 7);
            if (!monthlyMap[m]) monthlyMap[m] = { recolecciones: 0, entregas: 0 };
            monthlyMap[m].recolecciones++;
        }
        for (const e of entregas) {
            const m = new Date(e.date).toISOString().slice(0, 7);
            if (!monthlyMap[m]) monthlyMap[m] = { recolecciones: 0, entregas: 0 };
            monthlyMap[m].entregas++;
        }

        const totalTags = tags.length;
        const totalWashes = tags.reduce((s, t) => s + (Number(t.wash_count) || 0), 0);
        const avgWashCount = totalTags > 0 ? totalWashes / totalTags : 0;
        const damagedCount = tags.filter(t => t.damaged === true || t.status === 'Dañado').length;
        // 30-day return rate: unique EPCs returned (entrega) / unique EPCs sent out (recoleccion) in period
        const recentRecolecciones = recolecciones.filter(r => new Date(r.date) >= thirtyDaysAgo);
        const sentOut = new Set(recentRecolecciones.flatMap(r => r.EPCs || []));
        const returned = new Set(recentEntregas.flatMap(e => e.EPCs || []));
        const returnRate30d = sentOut.size > 0
            ? [...returned].filter(epc => sentOut.has(epc)).length / sentOut.size
            : 0;
        const articleBreakdown = {};
        const articleWashes = {};
        const articleCounts = {};
        for (const tag of tags) {
            if (!tag.article) continue;
            if (!articleWashes[tag.article]) { articleWashes[tag.article] = 0; articleCounts[tag.article] = 0; }
            articleWashes[tag.article] += Number(tag.wash_count) || 0;
            articleCounts[tag.article]++;
        }
        for (const [art, total] of Object.entries(articleWashes)) {
            articleBreakdown[art] = articleCounts[art] > 0 ? total / articleCounts[art] : 0;
        }
        res.json({
            articles: [...articleSet].sort(),
            dailyUsage: Object.keys(dailyMap).sort().map(date => ({ date, ...dailyMap[date] })),
            monthlyActivity: Object.keys(monthlyMap).sort().map(month => ({ month, ...monthlyMap[month] })),
            statusBreakdown,
            currentlyOut: statusBreakdown['Recoleccion'] || 0,
            totalTags,
            avgWashCount,
            damagedCount,
            returnRate30d,
            articleBreakdown,
        });

    } catch (err) {
        console.error('Error en /api/analytics:', err);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

/**
 * GET /api/clients
 * Returns all client names sorted alphabetically.
 */
webApp.get('/api/clients', async (req, res) => {
    try {
        const clients = await mongoClient.db('on').collection('clientes')
            .find({}, { projection: { name: 1 } })
            .sort({ name: 1 })
            .toArray();
        res.json(clients.map(c => c.name));
    } catch (err) {
        console.error('/api/clients error:', err);
        res.status(500).json([]);
    }
});

/**
 * GET /api/client-articles?client=X
 * Returns all distinct article names that have tags for the given client,
 * sorted alphabetically. Used to pre-populate the manual entry panel.
 */
webApp.get('/api/client-articles', async (req, res) => {
    const clientName = req.query.client?.trim();
    if (!clientName) return res.json([]);
    try {
        const articles = await mongoClient.db('on').collection('tags')
            .distinct('article', { client: clientName });
        res.json(articles.sort());
    } catch (err) {
        console.error('/api/client-articles error:', err);
        res.status(500).json([]);
    }
});

/**
 * GET /api/pdf-data?client=X&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Returns all data needed to generate a PDF report for the given client and
 * date range. Defaults to the last 7 days when from/to are omitted.
 */
webApp.get('/api/pdf-data', async (req, res) => {
    const clientName = req.query.client?.trim();
    if (!clientName) return res.status(400).json({ error: 'client param required' });

    const fromDate = req.query.from
        ? new Date(req.query.from + 'T00:00:00')
        : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const toDate = req.query.to
        ? new Date(req.query.to + 'T23:59:59')
        : new Date();

    try {
        const db = mongoClient.db("on");
        const [tags, entregas, recolecciones] = await Promise.all([
            db.collection('tags').find({ client: clientName },
                { projection: { status: 1, article: 1, wash_count: 1, damaged: 1 } }).toArray(),
            db.collection('entrega').find({ client: clientName, date: { $gte: fromDate, $lte: toDate } })
                .sort({ date: -1 }).toArray(),
            db.collection('recoleccion').find({ client: clientName, date: { $gte: fromDate, $lte: toDate } })
                .sort({ date: -1 }).toArray()
        ]);

        // Article breakdown (all-time, from tags)
        const articleMap = {};
        let totalWashes = 0;
        for (const tag of tags) {
            const art = tag.article || 'Sin artículo';
            if (!articleMap[art]) articleMap[art] = { count: 0, totalWashes: 0 };
            articleMap[art].count++;
            articleMap[art].totalWashes += tag.wash_count || 0;
            totalWashes += tag.wash_count || 0;
        }
        const articleBreakdown = Object.entries(articleMap)
            .map(([article, d]) => ({
                article,
                count: d.count,
                totalWashes: d.totalWashes,
                avgWashes: d.count > 0 ? (d.totalWashes / d.count).toFixed(1) : '0'
            }))
            .sort((a, b) => b.count - a.count);

        // Status breakdown
        const statusBreakdown = {};
        for (const tag of tags) {
            const s = tag.status || 'Sin actualización';
            statusBreakdown[s] = (statusBreakdown[s] || 0) + 1;
        }

        // Events in range
        const sumArticles = (articles) =>
            Object.values(articles || {}).reduce((s, v) => s + Number(v), 0);

        const events = [
            ...recolecciones.map(e => ({
                date: e.date,
                type: 'Recolección',
                articles: Object.entries(e.articles || {}).map(([a, c]) => `${c}x ${a}`).join(', '),
                epcCount: (e.EPCs || []).length
            })),
            ...entregas.map(e => ({
                date: e.date,
                type: 'Entrega',
                articles: Object.entries(e.articles || {}).map(([a, c]) => `${c}x ${a}`).join(', '),
                epcCount: (e.EPCs || []).length
            }))
        ].sort((a, b) => new Date(b.date) - new Date(a.date));

        const totalPrendasRecogidas  = recolecciones.reduce((s, r) => s + sumArticles(r.articles), 0);
        const totalPrendasEntregadas = entregas.reduce((s, e) => s + sumArticles(e.articles), 0);
        const returnRate = recolecciones.length > 0
            ? Math.round((entregas.length / recolecciones.length) * 100)
            : null;

        // Daily garment counts per article (recolecciones + entregas in the date range)
        const dailyMap = {};
        const dailyArticleSet = new Set();
        for (const tx of [...recolecciones, ...entregas]) {
            const day = new Date(tx.date).toISOString().slice(0, 10);
            if (!dailyMap[day]) dailyMap[day] = {};
            for (const [article, count] of Object.entries(tx.articles || {})) {
                dailyArticleSet.add(article);
                dailyMap[day][article] = (dailyMap[day][article] || 0) + Number(count);
            }
        }
        const dailyArticles = [...dailyArticleSet].sort();
        const dailyUsage = Object.keys(dailyMap).sort().map(date => ({ date, ...dailyMap[date] }));

        // ── Extra data for insightful report ─────────────────────────────────

        // Helper: sum all statuses in a snapshot entry
        const snapTotals = (snap) => {
            const t = {};
            for (const [art, statuses] of Object.entries(snap?.snapshot || {}))
                t[art] = Object.values(statuses).reduce((s, v) => s + Number(v), 0);
            return t;
        };

        // Inventory at start and end of period (from snapshots)
        const [snapAtStart, snapAtEnd] = await Promise.all([
            db.collection('inventory_snapshots')
                .findOne({ client: clientName, date: { $lte: fromDate.toISOString().slice(0, 10) } }, { sort: { date: -1 } }),
            db.collection('inventory_snapshots')
                .findOne({ client: clientName, date: { $lte: toDate.toISOString().slice(0, 10) } }, { sort: { date: -1 } })
        ]);
        const startTotals = snapTotals(snapAtStart);
        const endTotals   = snapTotals(snapAtEnd);
        const allArtKeys  = new Set([...Object.keys(startTotals), ...Object.keys(endTotals)]);
        const comparison  = [...allArtKeys]
            .map(art => ({ article: art, prev: startTotals[art] || 0, curr: endTotals[art] || 0,
                           delta: (endTotals[art] || 0) - (startTotals[art] || 0) }))
            .sort((a, b) => b.curr - a.curr);

        // Weekly trend: last 6 weeks (one snapshot per Sun-Sat bucket)
        const rawSnaps = await db.collection('inventory_snapshots')
            .find({ client: clientName })
            .sort({ date: -1 })
            .limit(60)
            .toArray();
        const weekBuckets = {};
        for (const snap of rawSnaps) {
            const d = new Date(snap.date);
            const sunday = new Date(d);
            sunday.setDate(d.getDate() + (7 - d.getDay()) % 7);
            const wk = sunday.toISOString().slice(0, 10);
            if (!weekBuckets[wk] || snap.date > weekBuckets[wk].date) weekBuckets[wk] = snap;
        }
        const weeklyTrend = Object.values(weekBuckets)
            .sort((a, b) => (a.date < b.date ? -1 : 1))
            .slice(-6)
            .map(snap => ({ date: snap.date, articles: snapTotals(snap) }));

        // Thresholds for lifecycle context in insights
        const clientDoc  = await db.collection('clientes').findOne({ name: clientName }, { projection: { thresholds: 1 } });
        const thresholds = clientDoc?.thresholds || {};

        res.json({
            client: clientName,
            from: fromDate.toISOString(),
            to: toDate.toISOString(),
            stats: {
                totalItems: tags.length,
                totalWashCount: totalWashes,
                overallAvg: tags.length > 0 ? (totalWashes / tags.length).toFixed(1) : '0',
                currentlyOut: statusBreakdown['Recoleccion'] || 0,
                damagedCount: tags.filter(t => t.damaged).length
            },
            articleBreakdown,
            events: events.slice(0, 100),
            summary: {
                totalRecolecciones: recolecciones.length,
                totalEntregas: entregas.length,
                totalPrendasRecogidas,
                totalPrendasEntregadas
            },
            returnRate,
            dailyUsage,
            dailyArticles,
            comparison,
            weeklyTrend,
            thresholds
        });

    } catch (err) {
        console.error('Error en /api/pdf-data:', err);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

/**
 * GET /api/article-status?client=X&days=N
 *
 * Returns the live per-article × per-status breakdown plus up to N days of
 * daily historical snapshots from the `inventory_snapshots` collection.
 * Default window: 30 days, max 90.
 */
webApp.get('/api/article-status', async (req, res) => {
    const clientName = req.query.client?.trim();
    if (!clientName) return res.status(400).json({ error: 'client param required' });
    const days = Math.min(parseInt(req.query.days) || 30, 90);
    try {
        const db = mongoClient.db('on');

        // Live current breakdown from tags
        const rows = await db.collection('tags').aggregate([
            { $match: { client: clientName } },
            { $group: { _id: { article: '$article', status: '$status' }, count: { $sum: 1 } } }
        ]).toArray();

        const current = {};
        const articleSet = new Set();
        const statusSet  = new Set();
        for (const r of rows) {
            const art = r._id.article, st = r._id.status;
            articleSet.add(art); statusSet.add(st);
            if (!current[art]) current[art] = {};
            current[art][st] = r.count;
        }

        // Historical daily snapshots
        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const history = await db.collection('inventory_snapshots')
            .find({ client: clientName, date: { $gte: since } })
            .sort({ date: 1 }).toArray();

        res.json({
            articles: [...articleSet].sort(),
            statuses: [...statusSet].sort(),
            current,
            history: history.map(h => ({ date: h.date, snapshot: h.snapshot }))
        });
    } catch (err) {
        console.error('Error en /api/article-status:', err);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

webApp.get('/dashboard', async (req, res) => {
    res.render('find_client')
})

webApp.get('/datos', async (req, res) => {
    try {
        console.log(req.query)
        const client_name = req.query.name;
        // const client_name = 'Madero Express'

        // Better: check if name was actually sent
        if (!client_name || typeof client_name !== 'string' || client_name.trim() === '') {
            return res.status(400).json({ error: 'Se requiere el nombre del cliente (campo "name")' });
        }

        console.log('Buscando para cliente:', client_name);

        const db = mongoClient.db("on");

        // ─── Recolecciones ───
        const recoleccionColl = db.collection("recoleccion");
        const recolecciones = await recoleccionColl
            .find({ client: client_name })
            .toArray();

        console.log('Recolecciones encontradas:', recolecciones.length);

        // ─── Entregas ───
        const entregaColl = db.collection("entrega");
        const entregas = await entregaColl
            .find({ client: client_name })
            .toArray();

        console.log('Entregas encontradas:', entregas.length);

        // ─── Daños (damage) ───
        const damageColl = db.collection("damage");
        const damages = await damageColl
            .find({ client: client_name })
            .toArray();

        console.log('Daños encontrados:', damages.length);

        // ─── Tags ───
        const tagsColl = db.collection("tags");
        const all_tags = await tagsColl
            .find({ client: client_name })
            .toArray();

        console.log('Tags encontrados:', all_tags.length);

        // Send everything back as JSON
        res.json({
            client: client_name,
            recolecciones,
            entregas,
            damages,     // or "daños" if you prefer Spanish key
            tags: all_tags
        });

    } catch (error) {
        console.error('Error en /datos:', error);
        res.status(500).json({
            error: 'Error al consultar los datos',
            details: error.message
        });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// ── Audit log ────────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

/**
 * Appends one document to the `audit` collection. Non-blocking — failures are
 * logged to console but never bubble up to callers.
 */
async function logAudit(action, data = {}) {
    try {
        await mongoClient.db("on").collection("audit").insertOne({
            action,
            ...data,
            timestamp: new Date()
        });
    } catch (e) {
        console.error('Audit log error:', e.message);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// ── Per-tag history ──────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

/**
 * GET /tag-history?epc=XXXX
 * Shows the full lifecycle of a single EPC: tag info, all recoleccion and
 * entrega events it appeared in, and any damage reports.
 */
webApp.get('/tag-history', async (req, res) => {
    const epc = req.query.epc?.trim().toUpperCase() || null;
    if (!epc) return res.render('tag_history', { epc: null, tag: null, events: [], damages: [], error: null });

    try {
        const db = mongoClient.db("on");

        const tag = await db.collection("tags").findOne({ scanId: epc });

        // All recolecciones and entregas that contain this EPC
        const [recols, entrs, dmgs] = await Promise.all([
            db.collection("recoleccion").find({ EPCs: epc }).sort({ date: -1 }).toArray(),
            db.collection("entrega").find({ EPCs: epc }).sort({ date: -1 }).toArray(),
            db.collection("damage").find({ epc }).sort({ date: -1 }).toArray()
        ]);

        const events = [
            ...recols.map(e => ({ ...e, type: 'recoleccion', typeLabel: 'Recolección' })),
            ...entrs.map(e => ({ ...e, type: 'entrega', typeLabel: 'Entrega' }))
        ].sort((a, b) => new Date(b.date) - new Date(a.date));

        res.render('tag_history', { epc, tag, events, damages: dmgs, error: null });

    } catch (err) {
        console.error('Error en tag-history:', err);
        res.render('tag_history', { epc, tag: null, events: [], damages: [], error: 'Error al consultar la base de datos.' });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// ── Loss / AWOL tracker ──────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

/**
 * GET /lost-tags?client=X&days=N
 * Returns tags whose last_seen is older than N days (default 30) and whose
 * status is not "Entregado" — these are considered potentially missing.
 */
webApp.get('/lost-tags', async (req, res) => {
    const clientName = req.query.client?.trim() || null;
    const days = parseInt(req.query.days) || 30;
    if (!clientName) return res.redirect('/dashboard');

    try {
        const db = mongoClient.db("on");
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

        const lostTags = await db.collection("tags")
            .find({
                client: clientName,
                last_seen: { $lt: cutoff.getTime() },
                status: { $ne: 'Entregado' }
            })
            .sort({ last_seen: 1 })
            .toArray();

        // Group by article
        const byArticle = {};
        for (const tag of lostTags) {
            const art = tag.article || 'Sin artículo';
            if (!byArticle[art]) byArticle[art] = [];
            byArticle[art].push(tag);
        }

        res.render('lost_tags', { clientName, days, lostTags, byArticle, total: lostTags.length, error: null });

    } catch (err) {
        console.error('Error en lost-tags:', err);
        res.render('lost_tags', { clientName, days, lostTags: [], byArticle: {}, total: 0, error: 'Error al consultar.' });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// ── Batch status corrector ───────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

/** GET /batch-status — render the batch corrector form */
webApp.get('/batch-status', (req, res) => {
    res.render('batch_status', { result: null, error: null });
});

/**
 * POST /api/batch-status
 * Force-sets the status of any number of EPCs to a specified value.
 * Body: { epcs: string[], status: string }
 */
webApp.post('/api/batch-status', async (req, res) => {
    try {
        let { epcs, status: newStatus } = req.body;
        const VALID_STATUSES = ['Sin actualizacion', 'Recoleccion', 'Entregado', 'Reprocesado', 'Conteo de Bodega'];

        if (!Array.isArray(epcs) || epcs.length === 0) return res.status(400).json({ error: 'epcs requeridos' });
        if (!VALID_STATUSES.includes(newStatus)) return res.status(400).json({ error: 'Status inválido' });

        epcs = epcs.map(e => String(e).trim().toUpperCase()).filter(e => /^[0-9A-F]{24}$/i.test(e));
        if (epcs.length === 0) return res.status(400).json({ error: 'Sin EPCs válidos' });

        const result = await mongoClient.db("on").collection("tags").updateMany(
            { scanId: { $in: epcs } },
            { $set: { status: newStatus, last_seen: Date.now() } }
        );

        await logAudit('batch-status', { epcs, newStatus, modified: result.modifiedCount });
        res.json({ success: true, matched: result.matchedCount, modified: result.modifiedCount });

    } catch (err) {
        console.error('Error en /api/batch-status:', err);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// ── Lifecycle thresholds ─────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/set-threshold
 * Saves per-article wash-count thresholds for a client.
 * Body: { client: string, article: string, threshold: number }
 */
webApp.post('/api/set-threshold', async (req, res) => {
    try {
        const { client: clientName, article, threshold } = req.body;
        if (!clientName?.trim() || !article?.trim() || !threshold) return res.status(400).json({ error: 'Faltan campos' });

        const thresh = parseInt(threshold);
        if (isNaN(thresh) || thresh < 1) return res.status(400).json({ error: 'Threshold inválido' });

        await mongoClient.db("on").collection("clientes").updateOne(
            { name: clientName.trim() },
            { $set: { [`thresholds.${article.trim()}`]: thresh } }
        );

        res.json({ success: true });
    } catch (err) {
        console.error('Error en /api/set-threshold:', err);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// ── Client comparison ────────────────────────────════════════════════════════
// ════════════════════════════════════════════════════════════════════════════

/** GET /compare — render comparison search form */
webApp.get('/compare', (req, res) => {
    res.render('compare', { clients: [], error: null, searched: false });
});

/**
 * POST /compare
 * Compares stats across multiple clients sent as a comma/newline-separated list.
 */
webApp.post('/compare', async (req, res) => {
    const raw = req.body.clients || '';
    const clientNames = [...new Set(
        raw.split(/[\n,]/).map(s => s.trim()).filter(Boolean)
    )].slice(0, 8); // cap at 8

    if (clientNames.length < 2) {
        return res.render('compare', { clients: [], error: 'Ingresa al menos 2 clientes.', searched: false });
    }

    try {
        const db = mongoClient.db("on");
        const tagsCol = db.collection("tags");
        const thirty = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const clients = await Promise.all(clientNames.map(async name => {
            const [agg, currentlyOut, recentEntregas, recentRecols, damages] = await Promise.all([
                tagsCol.aggregate([
                    { $match: { client: name } },
                    { $group: { _id: null, total: { $sum: 1 }, totalWashes: { $sum: '$wash_count' }, damaged: { $sum: { $cond: [{ $eq: ['$damaged', true] }, 1, 0] } } } }
                ]).toArray(),
                tagsCol.countDocuments({ client: name, status: 'Recoleccion' }),
                db.collection("entrega").countDocuments({ client: name, date: { $gte: thirty } }),
                db.collection("recoleccion").countDocuments({ client: name, date: { $gte: thirty } }),
                db.collection("damage").countDocuments({ client: name })
            ]);

            const s = agg[0] || { total: 0, totalWashes: 0, damaged: 0 };
            return {
                name,
                total: s.total,
                avgWashes: s.total > 0 ? (s.totalWashes / s.total).toFixed(1) : '0',
                damaged: damages,
                currentlyOut,
                recentEntregas,
                returnRate: recentRecols > 0 ? Math.round((recentEntregas / recentRecols) * 100) : null
            };
        }));

        res.render('compare', { clients, error: null, searched: true, raw });

    } catch (err) {
        console.error('Error en compare:', err);
        res.render('compare', { clients: [], error: 'Error al consultar.', searched: false, raw });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// ── Shareable summary (public, no auth) ──────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

/**
 * GET /summary?client=X&token=Y
 * Public read-only summary for a client. Token is HMAC-based so no DB storage needed.
 */
webApp.get('/summary', async (req, res) => {
    const clientName = req.query.client?.trim() || null;
    const token = req.query.token || '';

    if (!clientName || !verifySummaryToken(clientName, token)) {
        return res.render('client_summary', {
            client: null, stats: null, articles: [], lastEvents: [], error: 'Enlace inválido o expirado.'
        });
    }

    try {
        const db = mongoClient.db("on");
        const tagsCol = db.collection("tags");

        const [agg, articleBreakdown, lastRecol, lastEntrega, damages] = await Promise.all([
            tagsCol.aggregate([
                { $match: { client: clientName } },
                { $group: { _id: null, total: { $sum: 1 }, totalWashes: { $sum: '$wash_count' }, currentlyOut: { $sum: { $cond: [{ $eq: ['$status', 'Recoleccion'] }, 1, 0] } }, delivered: { $sum: { $cond: [{ $eq: ['$status', 'Entregado'] }, 1, 0] } } } }
            ]).toArray(),
            tagsCol.aggregate([
                { $match: { client: clientName } },
                { $group: { _id: '$article', count: { $sum: 1 } } },
                { $sort: { count: -1 } }
            ]).toArray(),
            db.collection("recoleccion").findOne({ client: clientName }, { sort: { date: -1 } }),
            db.collection("entrega").findOne({ client: clientName }, { sort: { date: -1 } }),
            db.collection("damage").countDocuments({ client: clientName })
        ]);

        const stats = agg[0] ? {
            total: agg[0].total,
            totalWashes: agg[0].totalWashes,
            currentlyOut: agg[0].currentlyOut,
            delivered: agg[0].delivered,
            damaged: damages,
            avgWashes: agg[0].total > 0 ? (agg[0].totalWashes / agg[0].total).toFixed(1) : '0'
        } : null;

        res.render('client_summary', {
            client: clientName,
            stats,
            articles: articleBreakdown,
            lastRecol,
            lastEntrega,
            error: null,
            generatedAt: new Date()
        });

    } catch (err) {
        console.error('Error en /summary:', err);
        res.render('client_summary', { client: clientName, stats: null, articles: [], lastEvents: [], error: 'Error al cargar.' });
    }
});

/**
 * GET /api/summary-token?client=X
 * Returns the shareable token for a client (admin only).
 */
webApp.get('/api/summary-token', (req, res) => {
    const clientName = req.query.client?.trim();
    if (!clientName) return res.status(400).json({ error: 'client requerido' });
    const token = genSummaryToken(clientName);
    const url = `/summary?client=${encodeURIComponent(clientName)}&token=${token}`;
    res.json({ token, url });
});

// ════════════════════════════════════════════════════════════════════════════
// ── Audit log viewer ─────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

/**
 * GET /audit-log?limit=50
 * Returns the most recent audit entries as JSON (admin only).
 */
webApp.get('/audit-log', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    try {
        const entries = await mongoClient.db("on").collection("audit")
            .find({}).sort({ timestamp: -1 }).limit(limit).toArray();
        res.json(entries);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// ── Inventory snapshot helpers ───────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

/**
 * Upserts one inventory_snapshots document for today, recording the current
 * article × status counts for the given client.  Called after every
 * transaction write and also by the nightly cron job.
 */
async function takeInventorySnapshot(db, clientName) {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await db.collection('tags').aggregate([
        { $match: { client: clientName } },
        { $group: { _id: { article: '$article', status: '$status' }, count: { $sum: 1 } } }
    ]).toArray();
    const snapshot = {};
    for (const r of rows) {
        const art = r._id.article, st = r._id.status;
        if (!snapshot[art]) snapshot[art] = {};
        snapshot[art][st] = r.count;
    }
    await db.collection('inventory_snapshots').updateOne(
        { client: clientName, date: today },
        { $set: { client: clientName, date: today, snapshot, updatedAt: new Date() } },
        { upsert: true }
    );
}

// ════════════════════════════════════════════════════════════════════════════
// ── Scheduled WhatsApp reports (node-cron) ──────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

async function buildClientReport(clientName, period) {
    const db = mongoClient.db("on");
    const cutoff = period === 'weekly'
        ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [tagAgg, recentEntregas, recentRecols, damages] = await Promise.all([
        db.collection("tags").aggregate([
            { $match: { client: clientName } },
            { $group: { _id: null, total: { $sum: 1 }, out: { $sum: { $cond: [{ $eq: ['$status', 'Recoleccion'] }, 1, 0] } } } }
        ]).toArray(),
        db.collection("entrega").countDocuments({ client: clientName, date: { $gte: cutoff } }),
        db.collection("recoleccion").countDocuments({ client: clientName, date: { $gte: cutoff } }),
        db.collection("damage").countDocuments({ client: clientName })
    ]);

    const s = tagAgg[0] || { total: 0, out: 0 };
    const label = period === 'weekly' ? 'Semanal' : 'Mensual';
    return `📊 Reporte ${label} — ${clientName}\n` +
        `• Total prendas: ${s.total}\n` +
        `• En circulación: ${s.out}\n` +
        `• Entregas (período): ${recentEntregas}\n` +
        `• Recolecciones (período): ${recentRecols}\n` +
        `• Prendas dañadas: ${damages}`;
}

async function sendScheduledReports(period) {
    try {
        const clients = await mongoClient.db("on").collection("clientes")
            .find({ numero: { $exists: true, $ne: null } }).toArray();

        for (const client of clients) {
            try {
                const msg = await buildClientReport(client.name, period);
                await sendMessage(msg, client.numero, 'recoleccion');
                console.log(`Reporte ${period} enviado a ${client.name}`);
            } catch (e) {
                console.error(`Error enviando reporte a ${client.name}:`, e.message);
            }
        }
    } catch (e) {
        console.error('Error en sendScheduledReports:', e.message);
    }
}

// Every Monday at 9 AM (Mexico City time)
cron.schedule('0 9 * * 1', () => sendScheduledReports('weekly'), { timezone: 'America/Mexico_City' });

// 1st of every month at 9 AM
cron.schedule('0 9 1 * *', () => sendScheduledReports('monthly'), { timezone: 'America/Mexico_City' });

// Nightly inventory snapshot — 23:55 Mexico City time
cron.schedule('55 23 * * *', async () => {
    const db = mongoClient.db('on');
    try {
        const clients = await db.collection('clientes').find({}, { projection: { name: 1 } }).toArray();
        for (const c of clients) await takeInventorySnapshot(db, c.name);
        console.log(`[snapshot] ${clients.length} clients snapshotted`);
    } catch (e) {
        console.error('[snapshot] nightly cron error:', e);
    }
}, { timezone: 'America/Mexico_City' });