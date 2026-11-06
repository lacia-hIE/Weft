import type {ReactElement} from 'react';
import type {DirectoryListing} from '@deepseek-ai/dsh-host-directory-picker/types';

/** Build-time facade for the pinned, unmodified DSH component; no second implementation. */
export declare function DirectoryBrowser(props:{
  open:boolean;
  busy:boolean;
  listDirectory(path?:string,signal?:AbortSignal):Promise<DirectoryListing>;
  createDirectory(path:string,name:string):Promise<string>;
  onOpen(path:string):void;
  onClose():void;
  t(key:string,values?:Record<string,unknown>):string;
}):ReactElement|null;
