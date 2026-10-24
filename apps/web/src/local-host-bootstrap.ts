import {installEnvironmentStorage} from './official/storage.ts';
const element=document.currentScript as HTMLScriptElement|null;
const {tenant,environment}=element?.dataset??{};
if(tenant&&environment)installEnvironmentStorage(tenant,environment);
