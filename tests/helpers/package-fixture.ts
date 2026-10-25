import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {declarationSchema} from '../../packages/package-install/src/contracts.ts';

export function archiveFiles(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [path, text] of Object.entries(files)) {
    const body = Buffer.from(text), header = Buffer.alloc(512);
    header.write('package/' + path, 0, 100, 'utf8'); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(body.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136); header.fill(32, 148, 156); header.write('0', 156);
    header.write('ustar\0', 257); header.write('00', 263);
    const sum = header.reduce((sum: number, byte: number) => sum + byte, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
export function packageFixture(options: {name?: string; version?: string; files?: Record<string, string>; patch?: object[]; client?: boolean; dependencies?: Record<string, string>; scripts?: Record<string, string>} = {}) {
  const name = options.name ?? '@weft-fixture/counter', version = options.version ?? '1.2.3';
  const declarationRaw = {patch: './cordis.patch.yml'};
  const patch = options.patch ?? [{insert: [{id: 'counter', name, config: {filename: '/workspace/package-result.txt', value: 'original'}}]}, {id: 'counter', config: {filename: '/workspace/package-result.txt', value: 'from-patch'}}];
  const manifest = {name, version, description: 'Fixture package', main: './host.js', exports: {'.': './host.js', './client': './client.js'},
    dsh: {bundle: declarationRaw, ...(options.client === false ? {} : {client: {platform: 'web'}})},
    ...(options.dependencies ? {dependencies: options.dependencies} : {}), ...(options.scripts ? {scripts: options.scripts} : {})};
  const bytes = archiveFiles({'package.json': JSON.stringify(manifest), 'cordis.patch.yml': JSON.stringify(patch),
    'host.js': `import {defineTool} from '@deepseek-ai/dsh-tools';export const inject=['fs','tools'];export const Config={'~standard':{version:1,vendor:'fixture',validate:value=>({value})}};export function apply(ctx,config){ctx.tools.register(defineTool({name:'package_save',description:'Save a value from the native bundle configuration',parameters:{},output:{schema:{type:'json'},render:()=>[]},execute:async()=>{const target=await ctx.fs.resolve(config.filename);await ctx.fs.writeText(target,config.value);return {saved:true,value:config.value}}}))}`,
    'client.js': 'import React from "react";export const inject=["slots"];export function apply(ctx){ctx.slots.register({name:"conversation.session.header.utilities",id:"package-fixture"},()=>React.createElement("button",null,"Package active"))}',
    ...options.files,
  });
  const tarball = `https://registry.npmjs.org/${name}/-/counter-${version}.tgz`;
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64');
  const lock = [{name, version, integrity, tarball}];
  return {name, version, manifest: {...manifest, dist: {tarball, integrity}}, bytes,
    input: {name, version, declarationRaw, declaration: declarationSchema.parse(declarationRaw), lock, packages: [{name, version, bytes: bytes.toString('base64')}]}};
}

/** Real CSS Modules, inline CSS, native controls and shared CSS/JS asset references. */
export function styledPackageFixture(version = '1.2.3') {
  return packageFixture({version,files:{
    'client.js': `import React from 'react';import {Button} from '@deepseek-ai/dsh-client-ui-primitives';import css from './card.module.css';import './global.css';import inline from './inline.css?inline';import icon from './icon.svg';export function apply(ctx){ctx.effect(()=>{const element=document.createElement('div');element.className=css.card;element.dataset.styledFixture='true';element.textContent='Styled plugin ${version}';const image=document.createElement('img');image.alt='Plugin icon';image.src=icon;element.append(image);const style=document.createElement('style');style.textContent=inline;document.head.append(style);document.body.append(element);return()=>{element.remove();style.remove()}});if(!React.createElement||!Button)throw new Error('Native UI instance missing')}`,
    'card.module.css': '.card { color: rgb(17, 34, 51); background-image: url(./icon.svg); }',
    'global.css': '[data-styled-fixture] { border-top: 3px solid rgb(12, 34, 56); }',
    'inline.css': '[data-styled-fixture] { border-bottom: 2px solid rgb(65, 43, 21); --fixture-icon: url(./icon.svg); }',
    'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><path fill="red" d="M0 0h8v8H0z"/></svg>',
  }});
}
