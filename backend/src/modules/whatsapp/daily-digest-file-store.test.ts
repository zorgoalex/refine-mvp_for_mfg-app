import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DailyDigestFileStore } from './daily-digest-file-store';

const paths: string[]=[];
const assertOwned=vi.fn().mockResolvedValue(undefined);

async function createStore() {
  const root=await mkdtemp(join(tmpdir(),'daily-digest-'));
  paths.push(root);
  const database={withAdvisoryLock:async (_key:string,handler:(assert:()=>Promise<void>)=>Promise<unknown>)=>handler(assertOwned)};
  const config={get:()=>root};
  return {root,store:new DailyDigestFileStore(database as never,config as never)};
}

afterEach(async()=>{
  for (const path of paths.splice(0)) await rm(path,{recursive:true,force:true});
  assertOwned.mockClear();
});

describe('DailyDigestFileStore',()=>{
  it('atomically writes private PNG bytes with metadata only and verifies them on read',async()=>{
    const {root,store}=await createStore();
    const png=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
    const expiresAt=new Date(Date.now()+60_000);
    const [file]=await store.writePages([{pageIndex:1,orderIds:[11,12],png}],expiresAt,assertOwned);
    const info=await stat(join(root,file.fileKey));
    expect(info.mode&0o777).toBe(0o600);
    expect(file).toMatchObject({sizeBytes:png.byteLength,expiresAt});
    const result=await store.readImage(file.fileKey,file.sha256,file.expiresAt,assertOwned);
    expect(result.bytes).toEqual(png);
    expect(await readFile(join(root,file.fileKey))).toEqual(png);
    expect(assertOwned).toHaveBeenCalled();
  });

  it('rejects expired images and path traversal without opening another file',async()=>{
    const {store}=await createStore();
    await expect(store.readImage('../secret','0'.repeat(64),new Date(Date.now()+1000),assertOwned)).rejects.toMatchObject({code:'WHATSAPP_DAILY_DIGEST_FILE_KEY_INVALID'});
    await expect(store.readImage('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-1.png','0'.repeat(64),new Date(Date.now()-1),assertOwned)).rejects.toMatchObject({code:'WHATSAPP_DAILY_DIGEST_IMAGE_EXPIRED'});
  });

  it('removes expired referenced images even when their mtime is recent',async()=>{
    const {root,store}=await createStore();
    const [file]=await store.writePages([{pageIndex:1,orderIds:[12],png:Buffer.from('png')}],new Date(Date.now()+10_000),assertOwned);
    const result=await store.sweep(new Map(),[file.fileKey],assertOwned);
    expect(result.expired).toEqual([file.fileKey]);
    await expect(stat(join(root,file.fileKey))).rejects.toMatchObject({code:'ENOENT'});
  });

  it('rejects a page larger than 1 MiB before it reaches disk',async()=>{
    const {root,store}=await createStore();
    await expect(store.writePages([{pageIndex:1,orderIds:[1],png:Buffer.alloc(1024*1024+1)}],new Date(Date.now()+1000),assertOwned))
      .rejects.toMatchObject({code:'WHATSAPP_DAILY_DIGEST_IMAGE_LIMIT'});
    expect(await stat(root).then(value=>value.size)).toBeGreaterThanOrEqual(0);
  });

  it('accepts and sweeps page 500, but rejects page 501 before writing',async()=>{
    const {root,store}=await createStore();
    const expiresAt=new Date(Date.now()+60_000);
    const pages=Array.from({length:500},(_,index)=>({pageIndex:index+1,orderIds:[index+1],png:Buffer.from('x')}));
    const files=await store.writePages(pages,expiresAt,assertOwned);
    expect(files).toHaveLength(500);
    expect(files[499].fileKey).toMatch(/-500\.png$/);
    const swept=await store.sweep(new Map(),[files[499].fileKey],assertOwned);
    expect(swept.expired).toEqual([files[499].fileKey]);
    await expect(stat(join(root,files[499].fileKey))).rejects.toMatchObject({code:'ENOENT'});
    await expect(store.writePages([{pageIndex:501,orderIds:[501],png:Buffer.from('x')}],expiresAt,assertOwned))
      .rejects.toMatchObject({code:'WHATSAPP_DAILY_DIGEST_PAGE_LIMIT'});
  });
});
