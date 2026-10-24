import type {EnvironmentRecord} from './contracts.ts';
export interface EnvironmentLifecycleJob {
  tenantId:string;
  record:EnvironmentRecord;
  cursor:number;
  resources?:{sessions:string[];volumes:string[]};
}
