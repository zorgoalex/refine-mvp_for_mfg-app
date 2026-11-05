import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { captureNewMdfBathResult, lockMdfCutOwners, recheckMdfCutOwners, registerNewMdfBathResult } from './mdf-cut-source';
import { requireMdfCommandBoundary } from '../application/mdf-command-boundary';
import { recordMdfReceipt } from '../application/mdf-receipt';
import { loadMdfExecutionDetails } from './mdf-execution-snapshot';
vi.mock('../application/mdf-command-boundary',()=>({ requireMdfCommandBoundary: vi.fn() }));
vi.mock('../application/mdf-receipt',()=>({ recordMdfReceipt: vi.fn() }));
vi.mock('./mdf-execution-snapshot',()=>({ loadMdfExecutionDetails: vi.fn() }));
const user: CurrentUser={ id:'1',username:'E2E',role:'admin',roleId:1,permissions:['cut.manage','orders.view'] };
const input={ cutJobId:1,cutResultId:7,user,requestId:'E2E' },owner={ cutJobId:1,commandId:'E2E',user };
function fixture() {
  const item={ itemId:'det-10',orderId:1,detailId:10 as number|null,hdfId:null as number|null,sourceType:'order_detail',
    liveOrderId:1 as number|null,quantity:4,selectedQuantity:2,material:'МДФ 10 мм',width:100,height:200 };
  const placement={ itemId:'det-10',orderId:1 as number|null,detailId:10 as number|null,quantity:2 };
  const header={ isVacuum:true,name:'E2E bath',createdAt:'2026-09-22T00:00:00Z',complete:true,hasPrior:false };
  const state={ items:[item],placements:[placement],header,existing:false,allow:true };
  const query=vi.fn(async(sql:string)=>{
    let rows: unknown[]=[];
    if(sql.includes('FROM cut_job_item i')) rows=structuredClone(state.items);
    else if(sql.includes('SELECT o.order_id FROM orders')) rows=state.allow?[{ order_id:1 }]:[];
    else if(sql.includes('FROM cut_result r JOIN')) rows=[state.header];
    else if(sql.includes('FROM cut_result_placement p JOIN')) rows=state.placements;
    else if(sql.includes('FROM mdf_source_heads')) rows=state.existing?[{}]:[];
    else if(sql.includes('FROM status_automation_rules')) rows=[{ ruleId:13,version:2 }];
    return { rows,rowCount:rows.length };
  });
  const tx={ query } as unknown as TransactionClient;
  const prepare=async()=>{ await lockMdfCutOwners(tx,owner); await recheckMdfCutOwners(tx,owner); registerNewMdfBathResult(tx,7); };
  return { tx,state,item,placement,prepare,query };
}
beforeEach(()=>{
  vi.clearAllMocks(); vi.mocked(requireMdfCommandBoundary).mockResolvedValue({ mode:'active',queued:true });
  vi.mocked(recordMdfReceipt).mockResolvedValue({ jobId:'E2E-job' } as never);
  vi.mocked(loadMdfExecutionDetails).mockResolvedValue([{ orderId:1,detailId:10,quantity:4,rank:1 },{ orderId:1,detailId:11,quantity:1,rank:1 }]);
});
describe('verified new bath membership',()=>{
  it.each(['МДФ 10 мм','MDF 16 mm','МДФ влагостойкий 18'])('recognizes %s, freezes full demand, records membership only',async material=>{
    const f=fixture(); f.item.material=material; await f.prepare(); expect(await captureNewMdfBathResult(f.tx,input)).toBe('E2E-job');
    expect(recordMdfReceipt).toHaveBeenCalledWith(f.tx,expect.objectContaining({ accept:true,rules:[{ ruleId:13,version:2 }],
      lines:[{ lineKey:'det-10',orderId:1,detailId:10,quantity:2,stageCode:'membership',evidenceKind:'derived',rework:false }],
      executionContext:expect.objectContaining({ priorColumn:'baths',compositionComplete:true,demand:expect.arrayContaining([{ orderId:1,detailId:11,quantity:1 }]) }) }));
    expect(f.query.mock.calls.every(([sql])=>!sql.includes('snapshot_job'))).toBe(true);
  });
  it.each(['HDF','ХДФ МДФ','fanera','LDSP'])('explicitly excludes material %s',async material=>{
    const f=fixture(); f.item.material=material; await f.prepare(); expect(await captureNewMdfBathResult(f.tx,input)).toBeUndefined(); expect(recordMdfReceipt).not.toHaveBeenCalled();
  });
  it('excludes typed HDF even under an MDF material name',async()=>{
    const f=fixture(); Object.assign(f.item,{ sourceType:'order_hdf_detail',hdfId:40,detailId:null }); f.placement.detailId=null;
    await f.prepare(); expect(await captureNewMdfBathResult(f.tx,input)).toBeUndefined(); expect(recordMdfReceipt).not.toHaveBeenCalled();
  });
  it.each(['projection','unresolved','reparented','over-demand','over-selection','recycled','duplicate'] as const)('rejects %s without receipt',async issue=>{
    const f=fixture();
    if(issue==='projection') f.state.header.complete=false;
    if(issue==='unresolved') f.placement.detailId=null;
    if(issue==='reparented') f.item.liveOrderId=2;
    if(issue==='over-demand') f.placement.quantity=5;
    if(issue==='over-selection') f.placement.quantity=3;
    if(issue==='recycled') f.state.existing=true;
    if(issue==='duplicate') f.state.placements.push({ ...f.placement });
    await f.prepare(); await expect(captureNewMdfBathResult(f.tx,input)).rejects.toMatchObject({ code:'MDF_CUT_SOURCE_INVALID' });
    expect(recordMdfReceipt).not.toHaveBeenCalled();
  });
  it('missing head is never INSERT provenance; another transaction cannot use registration',async()=>{
    const f=fixture(),other=fixture(); await lockMdfCutOwners(f.tx,owner); registerNewMdfBathResult(other.tx,7);
    await expect(captureNewMdfBathResult(f.tx,input)).rejects.toMatchObject({ code:'MDF_CUT_SOURCE_INVALID' });
  });
  it('prior result quarantines composition without inventing unresolved membership',async()=>{
    const f=fixture(); f.state.header.hasPrior=true; await f.prepare(); await captureNewMdfBathResult(f.tx,input);
    expect(recordMdfReceipt).toHaveBeenCalledWith(f.tx,expect.objectContaining({ accept:false,executionContext:expect.objectContaining({ compositionComplete:true }) }));
  });
  it('changed basket after owner locks fails without acquiring late owner locks',async()=>{
    const f=fixture(); await lockMdfCutOwners(f.tx,owner); f.item.orderId=2;
    await expect(recheckMdfCutOwners(f.tx,owner)).rejects.toMatchObject({ code:'MDF_CUT_SCOPE_CHANGED' });
    expect(f.query.mock.calls.filter(([sql])=>sql.includes('SELECT o.order_id FROM orders'))).toHaveLength(1);
  });
  it('missing permission rejects before domain reads; unauthorized owner rejects before details',async()=>{
    const f=fixture(); await expect(lockMdfCutOwners(f.tx,{ ...owner,user:{ ...user,permissions:['cut.manage'] } })).rejects.toMatchObject({ code:'PERMISSION_DENIED' });
    expect(f.query).not.toHaveBeenCalled(); f.state.allow=false;
    await expect(lockMdfCutOwners(f.tx,owner)).rejects.toMatchObject({ code:'PERMISSION_DENIED' });
    expect(f.query.mock.calls.some(([sql])=>sql.includes('SELECT detail_id FROM order_details'))).toBe(false);
  });
  it('legacy/shadow do not read or write new evidence',async()=>{
    vi.mocked(requireMdfCommandBoundary).mockResolvedValue({ mode:'legacy',queued:false });
    const f=fixture(); await f.prepare(); expect(await captureNewMdfBathResult(f.tx,input)).toBeUndefined(); expect(f.query).not.toHaveBeenCalled();
  });
});
