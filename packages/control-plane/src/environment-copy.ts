import type {AgentRevision, ClientPlugin} from './contracts.ts';
import type {BundleState} from '../../native-bundles/src/catalog.ts';
import type {Installation} from '../../package-install/src/contracts.ts';

/** Configuration only: no session/approval/task identities or credential values. */
export interface EnvironmentCopyConfiguration {
  version: 1;
  configuration: string;
  presets: AgentRevision[];
  seeds: {id:string;revision:number}[];
  workspaces: {path:string;title:string}[];
  bundles: BundleState[];
  packages: Installation[];
  clients: ClientPlugin[];
}

/** Large rosters/package declarations must not become a single SQLite row. */
export class DurableCopySnapshots {
  constructor(private readonly storage:DurableObjectStorage) {
    storage.sql.exec('CREATE TABLE IF NOT EXISTS weft_environment_copy_snapshots (id TEXT NOT NULL, seq INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(id,seq)) STRICT');
  }
  get(id:string):string|undefined {
    const rows=this.storage.sql.exec<{seq:number;document:string}>('SELECT seq,document FROM weft_environment_copy_snapshots WHERE id=? ORDER BY seq',id).toArray();
    if(!rows.length)return;
    if(rows.some((row,index)=>row.seq!==index))throw new Error('Incomplete environment configuration snapshot');
    return rows.map(row=>row.document).join('');
  }
  put(id:string,document:string):void {
    this.storage.transactionSync(()=>{
      this.delete(id);
      for(let offset=0,seq=0;offset<document.length;seq++) {
        let end=Math.min(offset+65_536,document.length);
        const last=document.charCodeAt(end-1);
        if(end<document.length && last>=0xd800 && last<=0xdbff) end--;
        this.storage.sql.exec('INSERT INTO weft_environment_copy_snapshots VALUES (?,?,?)',id,seq,document.slice(offset,end));
        offset=end;
      }
    });
  }
  delete(id:string):void {this.storage.sql.exec('DELETE FROM weft_environment_copy_snapshots WHERE id=?',id);}
}
