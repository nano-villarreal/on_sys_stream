/**
 * Seed script — populates real client data from PDF delivery summaries.
 *
 * Usage:
 *   node seed-clients.js                          # skip clients that already exist
 *   node seed-clients.js --force                  # wipe and re-seed all
 *   node seed-clients.js --force --only Cenacolo  # wipe/re-seed one client
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGO_LINK;
const DB_NAME   = 'on';
const FORCE     = process.argv.includes('--force');
const ONLY_IDX  = process.argv.indexOf('--only');
const ONLY      = ONLY_IDX !== -1 ? process.argv[ONLY_IDX + 1] : null;

// ── helpers ───────────────────────────────────────────────────────────────────

function d(y, m, day) { return new Date(y, m - 1, day); }

// Strip zero-count articles so the DB stays clean
function clean(obj) {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v > 0));
}

// ── DATA ─────────────────────────────────────────────────────────────────────
// Source: weekly delivery summaries (Resumen de Entregas PDFs, 2026)
// Each record = one weekly total → stored as a single manual entrega
// ─────────────────────────────────────────────────────────────────────────────

// ── MADERO (Mar 24 – Jun 14, 2026) ───────────────────────────────────────────
const MADERO = {
    name: 'Madero',
    numero: '+15129654086',
    entregas: [
        { date: d(2026,3,30),  articles: clean({ 'Almohada':1, 'Funda Almohada Mat/Queen':380, 'Sabanas Mat/Queen':422, 'Cobertor':8,  'Protector de colchon':2, 'Toalla Baño':342, 'Toalla Mano':197, 'Pie de cama':4 }) },
        { date: d(2026,4,6),   articles: clean({ 'Funda Almohada Mat/Queen':487, 'Sabanas Mat/Queen':427, 'Cobertor':11, 'Protector de colchon':7, 'Toalla Baño':365, 'Toalla Mano':203, 'Pie de cama':3 }) },
        { date: d(2026,4,13),  articles: clean({ 'Almohada':4, 'Funda Almohada Mat/Queen':466, 'Sabanas Mat/Queen':501, 'Cobertor':15, 'Protector de colchon':2, 'Toalla Baño':452, 'Toalla Mano':196, 'Pie de cama':9, 'Cojin':1 }) },
        { date: d(2026,4,20),  articles: clean({ 'Almohada':6, 'Funda Almohada Mat/Queen':460, 'Sabanas Mat/Queen':394, 'Cobertor':23, 'Protector de colchon':2, 'Toalla Baño':368, 'Toalla Mano':188, 'Pie de cama':5 }) },
        { date: d(2026,4,27),  articles: clean({ 'Almohada':5, 'Funda Almohada Mat/Queen':444, 'Sabanas Mat/Queen':416, 'Cobertor':10, 'Protector de colchon':2, 'Toalla Baño':385, 'Toalla Mano':185, 'Pie de cama':3 }) },
        { date: d(2026,5,4),   articles: clean({ 'Almohada':2, 'Funda Almohada Mat/Queen':494, 'Sabanas Mat/Queen':468, 'Cobertor':20, 'Toalla Baño':426, 'Toalla Mano':197, 'Pie de cama':4 }) },
        { date: d(2026,5,11),  articles: clean({ 'Almohada':4, 'Funda Almohada Mat/Queen':448, 'Sabanas Mat/Queen':402, 'Cobertor':10, 'Protector de colchon':4, 'Toalla Baño':346, 'Toalla Mano':167, 'Pie de cama':4 }) },
        { date: d(2026,5,17),  articles: clean({ 'Almohada':3, 'Funda Almohada Mat/Queen':404, 'Sabanas Mat/Queen':354, 'Cobertor':9,  'Protector de colchon':1, 'Toalla Baño':285, 'Toalla Mano':185, 'Pie de cama':5 }) },
        { date: d(2026,5,24),  articles: clean({ 'Funda Almohada Mat/Queen':482, 'Sabanas Mat/Queen':419, 'Cobertor':28, 'Protector de colchon':1, 'Toalla Baño':417, 'Toalla Mano':176 }) },
        { date: d(2026,5,31),  articles: clean({ 'Almohada':2, 'Funda Almohada Mat/Queen':509, 'Sabanas Mat/Queen':480, 'Cobertor':11, 'Protector de colchon':1, 'Toalla Baño':449, 'Toalla Mano':218, 'Pie de cama':4 }) },
        { date: d(2026,6,7),   articles: clean({ 'Almohada':1, 'Funda Almohada Mat/Queen':495, 'Sabanas Mat/Queen':456, 'Cobertor':11, 'Toalla Baño':344, 'Toalla Mano':185, 'Pie de cama':3 }) },
        { date: d(2026,6,14),  articles: clean({ 'Funda Almohada Mat/Queen':509, 'Sabanas Mat/Queen':472, 'Cobertor':10, 'Protector de colchon':3, 'Toalla Baño':369, 'Toalla Mano':183, 'Pie de cama':2 }) },
    ]
};

// ── HOLIDAY INN SAN JERONIMO (Mar 10 – Jun 14, 2026) ─────────────────────────
const HOLIDAY_INN = {
    name: 'Holiday Inn San Jeronimo',
    numero: '+15129654086',
    entregas: [
        { date: d(2026,3,16),  articles: clean({ 'Funda Almohada Mat/Queen':808,  'Funda Almohada King':567, 'Sabanas Mat/Queen':431, 'Sabana King':251, 'Duvet Mat/Queen':136, 'Duvet King':74 }) },
        { date: d(2026,3,23),  articles: clean({ 'Funda Almohada Mat/Queen':906,  'Funda Almohada King':649, 'Sabanas Mat/Queen':385, 'Sabana King':334, 'Duvet Mat/Queen':139, 'Duvet King':88 }) },
        { date: d(2026,3,30),  articles: clean({ 'Funda Almohada Mat/Queen':1032, 'Funda Almohada King':777, 'Sabanas Mat/Queen':498, 'Sabana King':344, 'Duvet Mat/Queen':139, 'Duvet King':111 }) },
        { date: d(2026,4,6),   articles: clean({ 'Funda Almohada Mat/Queen':178,  'Funda Almohada King':98,  'Sabanas Mat/Queen':409, 'Sabana King':162, 'Duvet Mat/Queen':165, 'Duvet King':67 }) },
        { date: d(2026,4,13),  articles: clean({ 'Funda Almohada Mat/Queen':3,    'Sabanas Mat/Queen':423, 'Sabana King':240, 'Duvet Mat/Queen':126, 'Duvet King':70 }) },
        { date: d(2026,4,20),  articles: clean({ 'Sabanas Mat/Queen':304, 'Sabana King':294, 'Duvet Mat/Queen':96,  'Duvet King':87 }) },
        { date: d(2026,4,27),  articles: clean({ 'Sabanas Mat/Queen':426, 'Sabana King':319, 'Duvet Mat/Queen':141, 'Duvet King':82 }) },
        { date: d(2026,5,4),   articles: clean({ 'Funda Almohada Mat/Queen':10, 'Sabanas Mat/Queen':430, 'Sabana King':268, 'Duvet Mat/Queen':120, 'Duvet King':68, 'Inserto Mat/Queen':15, 'Inserto King':1, 'Cobertor Mat/Queen':5, 'Protector Colchon Mat/Queen':12, 'Toalla de baño':21, 'Tapete':26 }) },
        { date: d(2026,5,11),  articles: clean({ 'Funda Almohada Mat/Queen':9,  'Sabanas Mat/Queen':391, 'Sabana King':266, 'Duvet Mat/Queen':133, 'Duvet King':92 }) },
        { date: d(2026,5,17),  articles: clean({ 'Sabanas Mat/Queen':370, 'Sabana King':236, 'Duvet Mat/Queen':102, 'Duvet King':64, 'Inserto King':6, 'Protector Colchon Mat/Queen':1 }) },
        { date: d(2026,5,24),  articles: clean({ 'Funda Almohada King':5, 'Sabanas Mat/Queen':402, 'Sabana King':302, 'Duvet Mat/Queen':109, 'Duvet King':106 }) },
        { date: d(2026,5,31),  articles: clean({ 'Sabanas Mat/Queen':444, 'Sabana King':254, 'Duvet Mat/Queen':113, 'Duvet King':85 }) },
        { date: d(2026,6,7),   articles: clean({ 'Funda Almohada Mat/Queen':4,  'Sabanas Mat/Queen':476, 'Sabana King':254, 'Duvet Mat/Queen':126, 'Duvet King':74 }) },
        { date: d(2026,6,14),  articles: clean({ 'Funda Almohada Mat/Queen':11, 'Sabanas Mat/Queen':434, 'Sabana King':199, 'Duvet Mat/Queen':118, 'Duvet King':59 }) },
    ]
};

// ── CENACOLO (May 04 – Jun 14, 2026) ─────────────────────────────────────────
const CENACOLO = {
    name: 'Cenacolo',
    numero: '+15129654086',
    entregas: [
        { date: d(2026,5,10),  articles: clean({ 'Servilletas':281, 'Mantel cuadrado med':28, 'Mantel cuadrado gde':23, 'Mantel ovalado med':9,  'Mantel ovalado gde':3, 'Molleton ch':2, 'Cubrebandeja cafe':2 }) },
        { date: d(2026,5,17),  articles: clean({ 'Servilletas':1015, 'Mantel cuadrado med':150, 'Mantel cuadrado gde':68, 'Mantel ovalado med':25, 'Mantel ovalado gde':16, 'Molleton ch':5, 'Molleton med':2, 'Molleton gde':1, 'Delantal':1, 'Cubrebandeja cafe':5, 'Trapos Blancos':3 }) },
        { date: d(2026,5,24),  articles: clean({ 'Servilletas':640, 'Mantel cuadrado gde':180, 'Mantel ovalado med':16, 'Mantel ovalado gde':11, 'Molleton ch':2, 'Molleton med':7, 'Tortillera':7 }) },
        { date: d(2026,5,31),  articles: clean({ 'Servilletas':564, 'Mantel cuadrado gde':109, 'Mantel ovalado med':15, 'Mantel ovalado gde':10, 'Molleton ch':4, 'Molleton med':4, 'Molleton gde':1, 'Delantal':5, 'Tortillera':9, 'Cubrebandejas':8 }) },
        { date: d(2026,6,7),   articles: clean({ 'Servilletas':823, 'Mantel cuadrado med':6,  'Mantel cuadrado gde':219, 'Mantel ovalado med':25, 'Mantel ovalado gde':9, 'Molleton ch':4, 'Molleton med':8, 'Delantal':3, 'Tortillera':14, 'Cubrebandejas':6 }) },
        { date: d(2026,6,14),  articles: clean({ 'Servilletas':740, 'Mantel cuadrado gde':162, 'Mantel ovalado med':25, 'Mantel ovalado gde':9, 'Molleton med':8, 'Delantal':3, 'Tortillera':14, 'Cubrebandejas':6 }) },
    ]
};

const ALL_CLIENTS = [MADERO, HOLIDAY_INN, CENACOLO];

// ── seed function ─────────────────────────────────────────────────────────────

async function seedClient(db, data) {
    if (ONLY && ONLY !== data.name) {
        console.log(`  skip "${data.name}" (--only ${ONLY})`);
        return;
    }

    const existing = await db.collection('clientes').findOne({ name: data.name });

    if (existing) {
        if (!FORCE) {
            console.log(`⚠  "${data.name}" already exists — skipping (use --force to re-seed)`);
            return;
        }
        process.stdout.write(`  wiping "${data.name}"… `);
        await Promise.all([
            db.collection('entrega').deleteMany({ client: data.name }),
            db.collection('recoleccion').deleteMany({ client: data.name }),
            db.collection('inventory_snapshots').deleteMany({ client: data.name }),
            db.collection('clientes').deleteOne({ name: data.name }),
        ]);
        console.log('done');
    }

    // Insert all weekly entrega records
    const entregaDocs = data.entregas.map(e => ({
        articles: e.articles,
        client:   data.name,
        date:     e.date,
        EPCs:     [],
        manual:   true,
    }));

    const entResult = await db.collection('entrega').insertMany(entregaDocs);
    const entIds    = Object.values(entResult.insertedIds);

    // Last entrega date for the client document
    const lastDate = data.entregas.reduce(
        (max, e) => (e.date > max ? e.date : max),
        new Date(0)
    );

    await db.collection('clientes').insertOne({
        name:             data.name,
        numero:           data.numero,
        recolecciones:    [],
        entregas:         entIds,
        tags:             [],
        last_entrega:     lastDate,
    });

    console.log(`✓  "${data.name}": ${entIds.length} entregas inserted`);
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
    if (!MONGO_URI) {
        console.error('MONGO_LINK not set — check your .env file');
        process.exit(1);
    }

    const client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db(DB_NAME);

    console.log(`Mode: ${FORCE ? '--force (wipe + re-seed)' : 'safe (skip existing)'}${ONLY ? ` · --only "${ONLY}"` : ''}\n`);

    for (const c of ALL_CLIENTS) {
        await seedClient(db, c);
    }

    await client.close();
    console.log('\nDone. Open the dashboard and search each client name to verify.');
}

main().catch(err => { console.error(err); process.exit(1); });
