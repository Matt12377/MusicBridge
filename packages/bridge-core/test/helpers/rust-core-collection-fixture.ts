import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/** 仅向新建合成库装入规模数据；不在正式入口导出，也不读取用户资料。 */
export function seedRustCollection(filePath: string, amount: number, start = 0): string[] {
  const db = new DatabaseSync(filePath), ids: string[] = [];
  const brands = ['TDK', 'Maxell', '中文品牌🎵', 'É', 'é', 'Straße', 'İSTANBUL', 'Sony%_'];
  const names = ['SA 90%', 'Metal_Master', 'HD 60', '全角Ｆ', 'Cobalt', '合成β'];
  const years = [null, 1900, 1990, 1999, 2000, 2200];
  try {
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    const model = db.prepare('INSERT INTO collection_models(id,identity_key,descriptor) VALUES (?,?,?)');
    const sku = db.prepare('INSERT INTO collection_skus(id,model_id,minutes) VALUES (?,?,?)');
    const lot = db.prepare('INSERT INTO inventory_lots(id,sku_id,acquired,sealed,opened,legacy,unknown,quantity_adjustment) VALUES (?,?,2,?,?,?,?,0)');
    const copy = db.prepare('INSERT INTO physical_copies(physical_id,lot_id,packaging,usage,available,origin) VALUES (?,?,?,?,?,?)');
    const photo = db.prepare('INSERT INTO collection_photos(id,model_id,content,content_hash,width,height) VALUES (?,?,?,?,1,1)');
    for (let index = start; index < start + amount; index++) {
      const id = randomUUID(), skuId = randomUUID(), lotId = randomUUID(); ids.push(id);
      model.run(id, randomUUID(), JSON.stringify({ brand: brands[index % brands.length], name: names[index % names.length],
        edition: index % 3 === 0 ? 'A_B%' : '一版', year: years[index % years.length],
        format: 'cassette', tapeType: 'II', identification: index % 5 === 0 ? 'partial' : 'verified' }));
      sku.run(skuId, id, index % 7 === 0 ? 0 : 90);
      const bucket = index % 4;
      lot.run(lotId, skuId, bucket === 0 ? 1 : 0, bucket === 1 ? 1 : 0, bucket === 2 ? 1 : 0, bucket === 3 ? 1 : 0);
      const states = [
        ['sealed', 'blank', 1, 'blank-pool'], ['opened', 'recorded', 1, 'legacy-registration'],
        ['unknown', 'erased', 1, 'unclassified'], ['opened', 'blank', 0, 'blank-pool'],
      ] as const;
      const state = states[bucket]!;
      copy.run(`MB-C-${String(100000 + index).padStart(6, '0')}`, lotId, ...state);
      if (index % 13 === 0) photo.run(randomUUID(), id, Buffer.from([0xff, 0xd8, 0xff, 0xd9]), randomUUID());
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
  return ids.toReversed();
}
