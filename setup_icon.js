const { MongoClient } = require('mongodb');
const uri = 'mongodb+srv://emiliano_db_user:DNGdWDuAP0ZimHuq@on.8pkxvkz.mongodb.net/?appName=on';

// All 9 invoices consolidated by article
const invoices = [
    {
        folio: 'INV-000502', date: new Date('2026-06-01T12:00:00Z'),
        articles: {
            'Servilleta': 1662,
            'Mantel': 46,
            'Mantel XL': 8,
            'Cojín': 2,
            'Funda Colchón Silla': 1,
        }
    },
    {
        folio: 'INV-000503', date: new Date('2026-06-01T14:00:00Z'),
        articles: {
            'Servilleta': 1391,
            'Mantel': 116,
            'Mantel XL': 11,
            'Molletón': 11,
            'Trapo': 3,
            'Mandil': 2,
            'Camisa': 1,
        }
    },
    {
        folio: 'INV-000506', date: new Date('2026-06-03T12:00:00Z'),
        articles: {
            'Servilleta': 1400,
            'Mantel': 95,
            'Mantel XL': 3,
            'Funda Colchón Silla': 7,
            'Cojín': 2,
            'Molletón': 10,
            'Trapo': 8,
        }
    },
    {
        folio: 'INV-000515', date: new Date('2026-06-06T12:00:00Z'),
        articles: {
            'Servilleta': 334,
            'Mantel': 7,
        }
    },
    {
        folio: 'INV-000526', date: new Date('2026-06-11T12:00:00Z'),
        articles: {
            'Servilleta': 450,
            'Mantel': 24,
            'Mantel XL': 9,
            'Molletón': 18,
        }
    },
    {
        folio: 'INV-000536', date: new Date('2026-06-17T12:00:00Z'),
        articles: {
            'Servilleta': 1569,
            'Mantel': 68,
            'Mantel XL': 6,
            'Molletón': 7,
        }
    },
    {
        folio: 'INV-000538', date: new Date('2026-06-18T12:00:00Z'),
        articles: {
            'Servilleta': 71,
            'Mantel': 56,
            'Mantel XL': 3,
            'Molletón': 4,
        }
    },
    {
        folio: 'INV-000544', date: new Date('2026-06-20T12:00:00Z'),
        articles: {
            'Servilleta': 989,
            'Mantel': 30,
            'Mantel XL': 6,
            'Molletón': 3,
        }
    },
    {
        folio: 'INV-000549', date: new Date('2026-06-22T12:00:00Z'),
        articles: {
            'Servilleta': 834,
            'Mantel': 7,
            'Cojín': 2,
            'Molletón': 3,
        }
    },
];

async function run() {
    const client = new MongoClient(uri);
    try {
        await client.connect();
        const db = client.db('on');

        // 1. Create Icon client if not exists
        const existing = await db.collection('clientes').findOne({ name: 'Icon' });
        if (!existing) {
            await db.collection('clientes').insertOne({ name: 'Icon', tags: [], createdAt: new Date() });
            console.log('Created client: Icon');
        } else {
            console.log('Client Icon already exists');
        }

        // 2. Insert rec + ent pairs for each invoice
        let recCount = 0, entCount = 0;
        for (const inv of invoices) {
            const recDate = new Date(inv.date.getTime() - 1000);
            const entDate = inv.date;

            const base = {
                client: 'Icon',
                articles: inv.articles,
                rfid_articles: inv.articles,
                EPCs: [],
                manual: true,
            };

            await db.collection('recoleccion').insertOne({ ...base, date: recDate });
            await db.collection('entrega').insertOne({ ...base, date: entDate });
            recCount++; entCount++;
            console.log(`${inv.folio} → rec ${recDate.toISOString()} | ent ${entDate.toISOString()}`);
        }

        console.log(`\nDone: ${recCount} recolecciones + ${entCount} entregas inserted for Icon`);
    } finally { await client.close(); }
}
run().catch(console.error);
