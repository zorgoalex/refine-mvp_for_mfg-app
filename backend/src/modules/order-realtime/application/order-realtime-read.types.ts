import type { CurrentUser } from '../../../permissions/current-user';
import type { OrderRealtimeCursor, OrderRealtimeEventRecord } from './order-realtime.types';

export interface AuthorizedOrderRealtimeContext {
  currentUser: CurrentUser;
  cutRefsAllowed: boolean;
  permissionVariant: 'status' | 'status_cut';
}

export interface OrderDetailCutJobLiveRef {
  cutJobId: number;
  resultNo: number;
  cutNumber: string;
  name: string;
  paramProfileId: number | null;
  profileName: string | null;
  profileIsActive: boolean | null;
}

export interface OrderDetailLiveState {
  detailId: number;
  productionStatusId: number | null;
  cutJob?: OrderDetailCutJobLiveRef | null;
  bathCutJob?: OrderDetailCutJobLiveRef | null;
}

export interface OrderDetailLiveSnapshot {
  orderId: number;
  streamEnabled: boolean;
  streamCursor: string;
  cutRefsAccess: 'allowed' | 'denied';
  details: OrderDetailLiveState[];
  etag: string;
}

export interface OrderRealtimeReplay {
  highWatermark: number;
  currentCursor: OrderRealtimeCursor;
  events: OrderRealtimeEventRecord[];
  cursorFuture: boolean;
  retentionGap: boolean;
  overflow: boolean;
}
