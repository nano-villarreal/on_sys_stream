/**
 * Seed script — creates a "demo" client with realistic fake data.
 * Run once:        node seed-demo.js
 * Force re-seed:   node seed-demo.js --force   (wipes existing demo data first)
 */

require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');

const MONGO_URI   = process.env.MONGO_LINK;
const DB_NAME     = 'on';
const CLIENT_NAME = 'demo';

// ── Article catalog ─────────────────────────────────────────────────────────
//   highWash: true → skew wash counts toward threshold (triggers lifecycle alerts)
const ARTICLES = [
    { name: 'Toalla de Baño',    count: 120, threshold: 80,  highWash: true  },
    { name: 'Toalla de Mano',    count: 85,  threshold: 100, highWash: false },
    { name: 'Sabana Queen',      count: 90,  threshold: 70,  highWash: true  },
    { name: 'Sabana King',       count: 60,  threshold: 70,  highWash: false },
    { name: 'Funda Almohada',    count: 95,  threshold: 60,  highWash: false },
    { name: 'Cobertor',          count: 40,  threshold: 50,  highWash: true  },
    { name: 'Bata',              count: 30,  threshold: 80,  highWash: false },
    { name: 'Pie de Cama',       count: 45,  threshold: 90,  highWash: false },
    { name: 'Mantel',            count: 55,  threshold: 100, highWash: false },
    { name: 'Servilleta',        count: 75,  threshold: 120, highWash: false },
];
// Total: 695 tags

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function sample(arr, n) {
    const copy = [...arr].sort(() => 0.5 - Math.random());
    return copy.slice(0, Math.min(n, copy.length));
}

// ── Tag generation ───────────────────────────────────────────────────────────

function buildTags() {
    const tags = [];

    for (const art of ARTICLES) {
        for (let i = 0; i < art.count; i++) {
            // Wash count distribution: highWash articles skew high to trigger alerts
            let wash_count;
            const roll = Math.random();
            if (art.highWash) {
                if (roll < 0.30)      wash_count = randomInt(art.threshold, art.threshold + 30);
                else if (roll < 0.55) wash_count = randomInt(Math.floor(art.threshold * 0.78), art.threshold - 1);
                else                  wash_count = randomInt(8, Math.floor(art.threshold * 0.70));
            } else {
                if (roll < 0.08)      wash_count = randomInt(art.threshold, art.threshold + 20);
                else if (roll < 0.22) wash_count = randomInt(Math.floor(art.threshold * 0.70), art.threshold - 1);
                else                  wash_count = randomInt(2, Math.floor(art.threshold * 0.65));
            }

            // Status distribution: varied and realistic
            let status;
            const s = Math.random();
            if (s < 0.32)       status = 'Entregado';
            else if (s < 0.62)  status = 'Recoleccion';
            else if (s < 0.80)  status = 'Conteo de Bodega';
            else if (s < 0.92)  status = 'Reprocesado';
            else                status = 'Sin actualizacion';

            tags.push({
                scanId:    randomHex(24),
                article:   art.name,
                client:    CLIENT_NAME,
                status,
                wash_count,
                damaged:   Math.random() < 0.04,
                damage:    false,
                last_seen: daysAgo(randomInt(0, 45)),
                createdAt: daysAgo(randomInt(180, 730)),
            });
        }
    }
    return tags;
}

// ── Transaction generation ────────────────────────────────────────────────────
// 80 recolecciones + 75 entregas spread over 365 days (≈ 6–7 per month each)
// Realistic batches: pick 4–7 article types, 15–80 units each

function buildTransactions(tagDocs) {
    const pools = {};
    for (const t of tagDocs) {
        if (!pools[t.article]) pools[t.article] = [];
        pools[t.article].push(t.scanId);
    }

    const recolecciones = [];
    const entregas      = [];

    // Spread 80 recolecciones fairly evenly over 365 days with some clustering
    const recDates = [];
    for (let i = 0; i < 80; i++) {
        // Bias toward more recent (last 90 days get ~40% of transactions)
        const daysBack = Math.random() < 0.40
            ? randomInt(1, 90)
            : randomInt(91, 365);
        recDates.push(daysBack);
    }
    recDates.sort((a, b) => b - a);

    for (const daysBack of recDates) {
        const pickedArts = sample(ARTICLES, randomInt(4, 7));
        const articles = {};
        const EPCs = [];

        for (const art of pickedArts) {
            const qty = randomInt(10, Math.min(60, Math.floor(pools[art.name].length * 0.6)));
            articles[art.name] = qty;
            EPCs.push(...sample(pools[art.name], qty));
        }

        recolecciones.push({
            articles,
            client: CLIENT_NAME,
            date:   daysAgo(daysBack),
            EPCs,
        });
    }

    // 75 entregas, same spread pattern
    const entDates = [];
    for (let i = 0; i < 75; i++) {
        const daysBack = Math.random() < 0.40
            ? randomInt(1, 85)
            : randomInt(86, 355);
        entDates.push(daysBack);
    }
    entDates.sort((a, b) => b - a);

    for (const daysBack of entDates) {
        const pickedArts = sample(ARTICLES, randomInt(4, 7));
        const articles = {};
        const EPCs = [];

        for (const art of pickedArts) {
            const qty = randomInt(8, Math.min(55, Math.floor(pools[art.name].length * 0.55)));
            articles[art.name] = qty;
            EPCs.push(...sample(pools[art.name], qty));
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

// ── Damage reports ────────────────────────────────────────────────────────────

const DAMAGE_DESCRIPTIONS = [
    'Desgarre en borde',
    'Mancha permanente de tinta',
    'Costura deshilachada',
    'Decoloración por exceso de cloro',
    'Rotura en tela',
    'Quemadura de plancha',
    'Desgaste extremo por uso',
    'Agujero central',
    'Pérdida de color (desteñido)',
    'Rasgado en esquina',
    'Bordado dañado',
    'Fieltro pelado en superficie',
];

function buildDamageReports(tagDocs) {
    const damaged = tagDocs.filter(t => t.damaged);
    return damaged.map((t, i) => ({
        epc:           t.scanId,
        description:   DAMAGE_DESCRIPTIONS[i % DAMAGE_DESCRIPTIONS.length],
        client:        CLIENT_NAME,
        date:          daysAgo(randomInt(2, 120)),
        imageUrl:      'https://res.cloudinary.com/demo/image/upload/v1/samples/landscapes/nature-mountains.jpg',
        imagePublicId: `demo_damage_${i}`,
    }));
}

// ── Inventory snapshots (90 days) ─────────────────────────────────────────────

function buildSnapshots(tagDocs) {
    const todaySnap = {};
    for (const art of ARTICLES) todaySnap[art.name] = {};
    for (const tag of tagDocs) {
        const art = tag.article;
        if (!todaySnap[art]) todaySnap[art] = {};
        todaySnap[art][tag.status] = (todaySnap[art][tag.status] || 0) + 1;
    }

    const snapDocs = [];

    for (let d = 90; d >= 0; d--) {
        const date = new Date();
        date.setDate(date.getDate() - d);
        const dateStr = date.toISOString().slice(0, 10);

        const snapshot = {};
        for (const art of ARTICLES) {
            const today = todaySnap[art.name] || {};
            const total = art.count;
            const jitter = (base, factor) => Math.max(0, base + Math.round((Math.random() - 0.5) * factor * Math.sqrt(d) / 5));

            const entregado = jitter(today['Entregado'] || 0, 12);
            const recol     = jitter(today['Recoleccion'] || 0, 10);
            const bodega    = jitter(today['Conteo de Bodega'] || 0, 6);
            const repro     = jitter(today['Reprocesado'] || 0, 3);
            const sinAct    = Math.max(0, total - entregado - recol - bodega - repro);

            snapshot[art.name] = {};
            if (entregado > 0) snapshot[art.name]['Entregado']        = entregado;
            if (recol > 0)     snapshot[art.name]['Recoleccion']      = recol;
            if (bodega > 0)    snapshot[art.name]['Conteo de Bodega'] = bodega;
            if (repro > 0)     snapshot[art.name]['Reprocesado']      = repro;
            if (sinAct > 0)    snapshot[art.name]['Sin actualizacion']= sinAct;
        }

        snapDocs.push({ client: CLIENT_NAME, date: dateStr, snapshot, updatedAt: date });
    }

    return snapDocs;
}

// ── Main ─────────────────────────────────────────────────────────────────────

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

    console.log('Building tags…');
    const tagDocs = buildTags();
    const tagResult = await db.collection('tags').insertMany(tagDocs);
    const tagIds = Object.values(tagResult.insertedIds);
    const tagDocsWithIds = tagDocs.map((t, i) => ({ ...t, _id: tagIds[i] }));
    console.log(`  ✓ ${tagIds.length} tags`);

    const { recolecciones, entregas } = buildTransactions(tagDocsWithIds);

    console.log('Building recolecciones…');
    const recResult = await db.collection('recoleccion').insertMany(recolecciones);
    const recIds = Object.values(recResult.insertedIds);
    console.log(`  ✓ ${recIds.length} recolecciones`);

    console.log('Building entregas…');
    const entResult = await db.collection('entrega').insertMany(entregas);
    const entIds = Object.values(entResult.insertedIds);
    console.log(`  ✓ ${entIds.length} entregas`);

    const damageDocs = buildDamageReports(tagDocsWithIds);
    if (damageDocs.length) {
        console.log('Building damage reports…');
        await db.collection('damage').insertMany(damageDocs);
        console.log(`  ✓ ${damageDocs.length} damage reports`);
    }

    console.log('Building 90-day inventory snapshots…');
    const snapDocs = buildSnapshots(tagDocsWithIds);
    await db.collection('inventory_snapshots').insertMany(snapDocs);
    console.log(`  ✓ ${snapDocs.length} daily snapshots`);

    console.log('Creating client document…');
    const thresholds = {};
    for (const art of ARTICLES) thresholds[art.name] = art.threshold;

    const sortedRec = [...recolecciones].sort((a, b) => b.date - a.date);
    const sortedEnt = [...entregas].sort((a, b) => b.date - a.date);

    await db.collection('clientes').insertOne({
        name:             CLIENT_NAME,
        numero:           '+15129654086',
        recolecciones:    recIds,
        entregas:         entIds,
        tags:             tagIds,
        thresholds,
        last_recoleccion: sortedRec[0]?.date || new Date(),
        last_entrega:     sortedEnt[0]?.date || new Date(),
    });

    const total = ARTICLES.reduce((s, a) => s + a.count, 0);
    console.log(`\n✓ Done!  ${total} tags · ${recIds.length} recolecciones · ${entIds.length} entregas · ${damageDocs.length} daños · ${snapDocs.length} snapshots`);
    console.log(`  Open the dashboard and search for: "${CLIENT_NAME}"`);
    await client.close();
}

main().catch(err => { console.error(err); process.exit(1); });
