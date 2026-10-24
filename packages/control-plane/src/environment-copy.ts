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
