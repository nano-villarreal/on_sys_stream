/**
 * Seed script — creates a "demo" client with realistic fake data.
 * Run once:        node seed-demo.js
 * Force re-seed:   node seed-demo.js --force   (wipes existing demo data first)
 */

require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');

const MONGO_URI = process.env.MONGO_LINK;
const DB_NAME   = 'on';
const CLIENT_NAME = 'demo';

// Article types and their realistic pool sizes
const ARTICLES = [
    { name: 'toalla',      count: 60, threshold: 80  },
    { name: 'mantel',      count: 40, threshold: 100 },
    { name: 'servilleta',  count: 50, threshold: 90  },
    { name: 'bata',        count: 20, threshold: 60  },
    { name: 'sabana',      count: 30, threshold: 70  },
];

// ── helpers ───────────────────────────────────────────────────────────────────

function randomHex(len) {
    let s = '';
    const chars = '0123456789ABCDEF';
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d;
}

// ── build tags ────────────────────────────────────────────────────────────────

function buildTags() {
    const tags = [];
    for (const art of ARTICLES) {
        for (let i = 0; i < art.count; i++) {
            // Spread wash counts: ~20% near/over threshold, rest varied
            let wash_count;
            const roll = Math.random();
            if (roll < 0.10)      wash_count = randomInt(art.threshold, art.threshold + 20); // over threshold
            else if (roll < 0.25) wash_count = randomInt(Math.floor(art.threshold * 0.8), art.threshold - 1); // warning zone
            else                  wash_count = randomInt(5, Math.floor(art.threshold * 0.75));

            // Status distribution: ~40% Entregado, ~35% Recoleccion (out), ~25% Sin actualizacion
            let status;
            const s = Math.random();
            if (s < 0.40)      status = 'Entregado';
            else if (s < 0.75) status = 'Recoleccion';
            else               status = 'Sin actualizacion';

            tags.push({
                scanId:     randomHex(24),
                article:    art.name,
                client:     CLIENT_NAME,
                status,
                wash_count,
                damaged:    Math.random() < 0.05,   // 5% damaged
                damage:     false,
                last_seen:  daysAgo(randomInt(0, 60)),
                createdAt:  daysAgo(randomInt(90, 365)),
            });
        }
    }
    return tags;
}

// ── build transactions ────────────────────────────────────────────────────────

function buildTransactions(tagDocs) {
    // Group tags by article for EPC pools
    const pools = {};
    for (const t of tagDocs) {
        if (!pools[t.article]) pools[t.article] = [];
        pools[t.article].push(t.scanId);
    }

    const recolecciones = [];
    const entregas      = [];

    // Create ~28 recoleccion + ~26 entrega transactions spread over 180 days
    const txDates = [];
    for (let i = 0; i < 28; i++) txDates.push(randomInt(1, 180));
    txDates.sort((a, b) => b - a); // oldest first

    for (const daysBack of txDates) {
        const articles = {};
        const EPCs     = [];

        for (const art of ARTICLES) {
            const qty = randomInt(3, Math.min(15, pools[art.name].length));
            articles[art.name] = qty;
            const sample = [...pools[art.name]].sort(() => 0.5 - Math.random()).slice(0, qty);
            EPCs.push(...sample);
        }

        recolecciones.push({
            articles,
            client: CLIENT_NAME,
            date:   daysAgo(daysBack),
            EPCs,
        });
    }

    // Entregas: slightly fewer, slightly more recent
    const entDates = [];
    for (let i = 0; i < 26; i++) entDates.push(randomInt(1, 170));
    entDates.sort((a, b) => b - a);

    for (const daysBack of entDates) {
        const articles = {};
        const EPCs     = [];

        for (const art of ARTICLES) {
            const qty = randomInt(3, Math.min(14, pools[art.name].length));
            articles[art.name] = qty;
            const sample = [...pools[art.name]].sort(() => 0.5 - Math.random()).slice(0, qty);
            EPCs.push(...sample);
        }

        entregas.push({
            articles,
            client: CLIENT_NAME,
            date:   daysAgo(daysBack),
            EPCs,
        });
    }

    return { recolecciones, entregas };
}

// ── build damage reports ──────────────────────────────────────────────────────

function buildDamageReports(tagDocs) {
    const damaged = tagDocs.filter(t => t.damaged).slice(0, 8);
    return damaged.map((t, i) => ({
        epc:          t.scanId,
        description:  ['Desgarre en borde', 'Mancha permanente', 'Costura deshilachada', 'Decoloración por cloro', 'Rotura en tela'][i % 5],
        client:       CLIENT_NAME,
        date:         daysAgo(randomInt(5, 60)),
        imageUrl:     'https://res.cloudinary.com/demo/image/upload/v1/samples/landscapes/nature-mountains.jpg',
        imagePublicId: `demo_damage_${i}`,
    }));
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
    const force = process.argv.includes('--force');
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db(DB_NAME);

    const existing = await db.collection('clientes').findOne({ name: CLIENT_NAME });
    if (existing) {
        if (!force) {
            console.log(`Client "${CLIENT_NAME}" already exists — nothing written.\nRun with --force to wipe and re-seed.`);
            await client.close();
            return;
        }
        console.log(`--force: wiping existing "${CLIENT_NAME}" data…`);
        await Promise.all([
            db.collection('tags').deleteMany({ client: CLIENT_NAME }),
            db.collection('recoleccion').deleteMany({ client: CLIENT_NAME }),
            db.collection('entrega').deleteMany({ client: CLIENT_NAME }),
            db.collection('damage').deleteMany({ client: CLIENT_NAME }),
            db.collection('inventory_snapshots').deleteMany({ client: CLIENT_NAME }),
            db.collection('clientes').deleteOne({ name: CLIENT_NAME }),
        ]);
        console.log('  ✓ Existing demo data wiped');
    }

    console.log('Inserting tags…');
    const tagDocs = buildTags();
    const tagResult = await db.collection('tags').insertMany(tagDocs);
    const insertedTagIds = Object.values(tagResult.insertedIds);
    console.log(`  ✓ ${insertedTagIds.length} tags`);

    const { recolecciones, entregas } = buildTransactions(
        tagDocs.map((t, i) => ({ ...t, _id: tagResult.insertedIds[i] }))
    );

    console.log('Inserting recolecciones…');
    const recResult = await db.collection('recoleccion').insertMany(recolecciones);
    const insertedRecIds = Object.values(recResult.insertedIds);
    console.log(`  ✓ ${insertedRecIds.length} recolecciones`);

    console.log('Inserting entregas…');
    const entResult = await db.collection('entrega').insertMany(entregas);
    const insertedEntIds = Object.values(entResult.insertedIds);
    console.log(`  ✓ ${insertedEntIds.length} entregas`);

    const damageDocs = buildDamageReports(tagDocs);
    if (damageDocs.length) {
        console.log('Inserting damage reports…');
        await db.collection('damage').insertMany(damageDocs);
        console.log(`  ✓ ${damageDocs.length} damage reports`);
    }

    console.log('Creating client document…');
    const thresholds = {};
    for (const art of ARTICLES) thresholds[art.name] = art.threshold;

    const sortedRec = [...recolecciones].sort((a, b) => b.date - a.date);
    const sortedEnt = [...entregas].sort((a, b) => b.date - a.date);

    await db.collection('clientes').insertOne({
        name:              CLIENT_NAME,
        numero:            '+15129654086',
        recolecciones:     insertedRecIds,
        entregas:          insertedEntIds,
        tags:              insertedTagIds,
        thresholds,
        last_recoleccion:  sortedRec[0]?.date || new Date(),
        last_entrega:      sortedEnt[0]?.date || new Date(),
    });

    // ── Backfill 30 days of inventory snapshots ──────────────────────────────
    // Simulate a realistic random walk so the trend chart has data from day 1.
    console.log('Seeding 30 days of inventory snapshots…');

    const STATUSES = ['Entregado', 'Recoleccion', 'Conteo de Bodega', 'Reprocesado', 'Sin actualizacion'];

    // Build today's real breakdown from the inserted tags
    const todaySnap = {};
    for (const art of ARTICLES) todaySnap[art.name] = {};
    for (const tag of tagDocs) {
        if (!todaySnap[tag.article]) todaySnap[tag.article] = {};
        todaySnap[tag.article][tag.status] = (todaySnap[tag.article][tag.status] || 0) + 1;
    }

    const snapDocs = [];
    for (let d = 30; d >= 0; d--) {
        const date = new Date();
        date.setDate(date.getDate() - d);
        const dateStr = date.toISOString().slice(0, 10);

        // For past days: apply a small random walk backwards from today's state
        const snapshot = {};
        for (const art of ARTICLES) {
            const total = art.count;
            const today = todaySnap[art.name] || {};
            snapshot[art.name] = {};
            let remaining = total;
            const jitter = (base, factor) => Math.max(0, base + Math.round((Math.random() - 0.5) * factor * d / 10));

            const entregado = jitter(today['Entregado'] || 0, 8);
            const recol     = jitter(today['Recoleccion'] || 0, 6);
            const bodega    = jitter(today['Conteo de Bodega'] || 0, 4);
            const repro     = jitter(today['Reprocesado'] || 0, 2);
            const sinAct    = Math.max(0, total - entregado - recol - bodega - repro);

            if (entregado > 0) snapshot[art.name]['Entregado'] = entregado;
            if (recol > 0)     snapshot[art.name]['Recoleccion'] = recol;
            if (bodega > 0)    snapshot[art.name]['Conteo de Bodega'] = bodega;
            if (repro > 0)     snapshot[art.name]['Reprocesado'] = repro;
            if (sinAct > 0)    snapshot[art.name]['Sin actualizacion'] = sinAct;
        }

        snapDocs.push({
            client: CLIENT_NAME,
            date: dateStr,
            snapshot,
            updatedAt: date,
        });
    }

    await db.collection('inventory_snapshots').insertMany(snapDocs);
    console.log(`  ✓ ${snapDocs.length} daily snapshots`);

    console.log(`\nDone! Open the dashboard and search for: "${CLIENT_NAME}"`);
    await client.close();
}

main().catch(err => { console.error(err); process.exit(1); });
