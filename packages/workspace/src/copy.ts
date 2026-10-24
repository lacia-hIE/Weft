import {createHash} from 'node:crypto';
import type {Workspace} from '@cloudflare/computer';
import {workspacePath} from './protocol.ts';

type Entry = {path: string; kind: string; mode: number; size: number; offset: number; bytes: ArrayBuffer | null};
/** A committed Computer-volume cut. This is the pinned dofs storage adapter,
 * never an export of tasks, private attachments or container runtime tables. */
export class WorkspaceCopy {
  constructor(private readonly storage: DurableObjectStorage, private readonly provider: ReturnType<Workspace['provider']>) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_copy_volumes (id TEXT PRIMARY KEY, count INTEGER NOT NULL) STRICT');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_copy_entries (id TEXT NOT NULL, seq INTEGER NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, mode INTEGER NOT NULL, size INTEGER NOT NULL, offset INTEGER NOT NULL, bytes BLOB, PRIMARY KEY(id,seq)) STRICT');
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_copy_import (id TEXT PRIMARY KEY, next INTEGER NOT NULL) STRICT');
  }
  capture(id: string): number {
    const existing = this.storage.sql.exec<{count: number}>('SELECT count FROM weft_copy_volumes WHERE id=?', id).toArray()[0];
    if (existing) return existing.count;
    // The single synchronous transaction fixes both directory metadata and bytes.
    // Changes committed after this cut cannot affect later transfer pages.
    return this.storage.transactionSync(() => {
      this.storage.sql.exec(`CREATE TABLE weft_copy_tree AS WITH RECURSIVE tree(inode,path) AS (
        SELECT child_inode,'/workspace' FROM vfs_dirents WHERE parent_inode=1 AND name='workspace'
        UNION ALL SELECT d.child_inode,t.path||'/'||d.name FROM tree t JOIN vfs_dirents d ON d.parent_inode=t.inode
        WHERE t.path NOT IN ('/workspace/.weft','/workspace/.dsh/spill')
      ) SELECT t.path,n.* FROM tree t JOIN vfs_nodes n USING(inode)
      WHERE t.path NOT IN ('/workspace/.weft','/workspace/.dsh/spill','/workspace/.dsh/profile.yml','/workspace/.dsh/profile.error.txt')`);
      try {
        if (this.storage.sql.exec("SELECT 1 FROM weft_copy_tree WHERE type NOT IN ('file','dir') OR mount_root IS NOT NULL OR stub_size IS NOT NULL LIMIT 1").toArray().length) throw new Error('The workspace contains a symlink or unloaded mount; materialize regular files before copying');
        this.storage.sql.exec(`INSERT INTO weft_copy_entries
          SELECT ?,ROW_NUMBER() OVER (ORDER BY t.path,c.idx)-1,t.path,t.type,t.mode,t.size,
            COALESCE(SUM(c.size) OVER (PARTITION BY t.inode ORDER BY c.idx ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0),b.bytes
          FROM weft_copy_tree t LEFT JOIN vfs_chunks c ON c.inode=t.inode LEFT JOIN vfs_blob_bytes b ON b.hash=c.hash
          ORDER BY t.path,c.idx`, id);
        if (this.storage.sql.exec("SELECT 1 FROM weft_copy_entries WHERE id=? AND kind='file' AND size>0 AND bytes IS NULL LIMIT 1",id).toArray().length) throw new Error('Workspace file bytes are not locally available');
        const count = this.storage.sql.exec<{count: number}>('SELECT COUNT(*) AS count FROM weft_copy_entries WHERE id=?',id).one().count;
        this.storage.sql.exec('INSERT INTO weft_copy_volumes VALUES (?,?)',id,count);
        return count;
      } finally {this.storage.sql.exec('DROP TABLE weft_copy_tree');}
    });
  }
  page(id: string, seq: number): Response {
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('Invalid copy cursor');
    const entry = this.storage.sql.exec<Entry>('SELECT path,kind,mode,size,offset,bytes FROM weft_copy_entries WHERE id=? AND seq=?',id,seq).toArray()[0];
    if (!entry) throw new Error('Copy snapshot or page is missing');
    const bytes = entry.bytes ?? new ArrayBuffer(0);
    return new Response(bytes, {headers: {'x-weft-copy-entry': encodeURIComponent(JSON.stringify({...entry,bytes:undefined,hash:createHash('sha256').update(new Uint8Array(bytes)).digest('hex')}))}});
  }
  next(id: string): number {return this.storage.sql.exec<{next: number}>('SELECT next FROM weft_copy_import WHERE id=?',id).toArray()[0]?.next ?? 0;}
  async accept(id: string, seq: number, response: Response): Promise<void> {
    const entry = JSON.parse(decodeURIComponent(response.headers.get('x-weft-copy-entry') ?? 'null')) as Entry & {hash: string};
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!entry || !['file','dir'].includes(entry.kind) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !Number.isSafeInteger(entry.offset) || entry.offset<0 || !Number.isInteger(entry.mode) || entry.offset+bytes.length>entry.size || createHash('sha256').update(bytes).digest('hex')!==entry.hash) throw new Error('Invalid workspace copy page');
    const path = workspacePath(entry.path);
    if (path==='/workspace/.weft' || path.startsWith('/workspace/.weft/')) throw new Error('Private attachments cannot be copied');
    this.storage.transactionSync(() => {
      const next = this.next(id);
      if(seq<next) return;
      if(seq!==next) throw new Error('Workspace copy page is out of order');
      if(entry.kind==='dir') this.provider.mkdirSync(path,{recursive:true});
      else {
        if(entry.offset===0) this.provider.writeFileSync(path,'');
        const fd=this.provider.openSync(path,'r+');
        try {this.provider.writeSync(fd,bytes,0,bytes.length,entry.offset);} finally {this.provider.closeSync(fd);}
        if(entry.offset+bytes.length===entry.size) this.provider.chmodSync(path,entry.mode);
      }
      this.storage.sql.exec('INSERT INTO weft_copy_import VALUES (?,?) ON CONFLICT(id) DO UPDATE SET next=excluded.next',id,seq+1);
    });
  }
  release(id: string): void {this.storage.transactionSync(()=>{this.storage.sql.exec('DELETE FROM weft_copy_entries WHERE id=?',id);this.storage.sql.exec('DELETE FROM weft_copy_volumes WHERE id=?',id);});}
}
