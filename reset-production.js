/**
 * Production reset — run ONCE to start with a clean slate.
 *
 *   node reset-production.js
 *
 * What it does:
 *   - All tags       → wash_count=0, status="Sin actualizacion", last_seen=null
 *   - All clientes   → recolecciones=[], entregas=[], removes last_recoleccion/last_entrega
 *   - Deletes every document in: recoleccion, entrega, inventory_snapshots
 */

require('dotenv').config();
const { MongoClient } = require('mongodb');

async function main() {
    const client = new MongoClient(process.env.MONGO_LINK);
    await client.connect();
    const db = client.db('on');

    // 1. Reset all tags
    const tagsResult = await db.collection('tags').updateMany(
        {},
        {
            $set:   { wash_count: 0, status: 'Sin actualizacion', last_seen: null },
        }
    );
    console.log(`✓ Tags reset: ${tagsResult.modifiedCount} updated`);

    // 2. Reset all clients
    const clientesResult = await db.collection('clientes').updateMany(
        {},
        {
            $set:   { recolecciones: [], entregas: [] },
            $unset: { last_recoleccion: '', last_entrega: '' },
        }
    );
    console.log(`✓ Clientes reset: ${clientesResult.modifiedCount} updated`);

    // 3. Wipe transaction collections
    const recDel  = await db.collection('recoleccion').deleteMany({});
    console.log(`✓ Recolecciones deleted: ${recDel.deletedCount}`);

    const entDel  = await db.collection('entrega').deleteMany({});
    console.log(`✓ Entregas deleted: ${entDel.deletedCount}`);

    const snapDel = await db.collection('inventory_snapshots').deleteMany({});
    console.log(`✓ Inventory snapshots deleted: ${snapDel.deletedCount}`);

    console.log('\nDone. System is at a clean slate.');
    await client.close();
}

main().catch(err => { console.error(err); process.exit(1); });
