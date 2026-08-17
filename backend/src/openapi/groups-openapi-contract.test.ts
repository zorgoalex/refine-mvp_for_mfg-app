import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('groups OpenAPI contract', () => {
  it('declares group routes and top-level Groups tag', () => {
    const contract = readOpenApiContract();
    const tagsSection = sectionBetween(contract, 'tags:\n', '\npaths:');

    expect(tagsSection).toContain('  - name: Groups');
    expect(contract).toContain('  /api/v1/groups:');
    expect(contract).toContain('  /api/v1/groups/lookup:');
    expect(contract).toContain('  /api/v1/groups/{groupId}:');
    expect(contract).toContain('  /api/v1/groups/{groupId}/members:');
    expect(contract).toContain('  /api/v1/groups/reports/orders:');
    expect(contract).toContain('  /api/v1/groups/reports/order-status-counts:');
    expect(contract).toContain('  /api/v1/groups/reports/production-status-counts:');
    expect(contract).toContain('  /api/v1/groups/reports/deadline-status-counts:');
    expect(contract).toContain('  /api/v1/groups/reports/order-relation-counts:');
    expect(contract).toContain('  /api/v1/groups/reports/order-created-month-counts:');
    expect(contract).toContain('  /api/v1/groups/{groupId}/overview:');
    expect(contract).toContain('  /api/v1/groups/{groupId}/batch-link:');
  });

  it('documents get group bad request and list pagination totalPages', () => {
    const contract = readOpenApiContract();
    const listSection = sectionBetween(
      contract,
      '  /api/v1/groups:',
      '  /api/v1/groups/lookup:',
    );
    const getSection = sectionBetween(
      contract,
      '  /api/v1/groups/{groupId}:',
      '  /api/v1/users:',
    );
    const listResponseSchema = sectionBetween(
      contract,
      '    GroupListResponse:',
      '    Pagination:',
    );

    expect(listSection).toContain("$ref: '#/components/schemas/GroupListResponse'");
    expect(listResponseSchema).toContain('- totalPages');
    expect(listResponseSchema).toContain('totalPages:');
    expect(getSection).toContain("'400':");
    expect(getSection).toContain("$ref: '#/components/responses/BadRequest'");
  });

  it('documents group write endpoints, permissions, and request schemas', () => {
    const contract = readOpenApiContract();
    const groupsSection = sectionBetween(
      contract,
      '  /api/v1/groups:',
      '  /api/v1/groups/lookup:',
    );
    const groupByIdSection = sectionBetween(
      contract,
      '  /api/v1/groups/{groupId}:',
      '  /api/v1/users:',
    );
    const createSchema = sectionBetween(
      contract,
      '    CreateGroupRequest:',
      '    UpdateGroupRequest:',
    );
    const updateSchema = sectionBetween(
      contract,
      '    UpdateGroupRequest:',
      '    Group:',
    );

    expect(groupsSection).toContain('post:');
    expect(groupsSection).toContain('operationId: createGroup');
    expect(groupsSection).toContain('x-permission: groups.create');
    expect(groupsSection).toContain("$ref: '#/components/schemas/CreateGroupRequest'");
    expect(groupByIdSection).toContain('patch:');
    expect(groupByIdSection).toContain('operationId: updateGroup');
    expect(groupByIdSection).toContain('x-permission: groups.update');
    expect(groupByIdSection).toContain('delete:');
    expect(groupByIdSection).toContain('operationId: archiveGroup');
    expect(groupByIdSection).toContain('x-permission: groups.archive');
    expect(createSchema).toContain('- code');
    expect(createSchema).toContain('pattern: ^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$');
    expect(createSchema).toContain('maxLength: 256');
    expect(updateSchema).toContain('minProperties: 1');
    expect(createSchema).toContain('enum: [draft, active, paused, completed]');
    expect(updateSchema).toContain('enum: [draft, active, paused, completed]');
    expect(updateSchema).not.toContain('enum: [draft, active, paused, completed, archived]');
  });

  it('documents group members GET and PUT endpoints with explicit members permissions', () => {
    const contract = readOpenApiContract();
    const membersSection = sectionBetween(
      contract,
      '  /api/v1/groups/{groupId}/members:',
      '  /api/v1/users:',
    );
    const replaceMembersSchema = sectionBetween(
      contract,
      '    ReplaceGroupMembersRequest:',
      '    GroupMember:',
    );
    const memberSchema = sectionBetween(
      contract,
      '    GroupMember:',
      '    GroupMembersResponse:',
    );
    const responseSchema = sectionBetween(
      contract,
      '    GroupMembersResponse:',
      '    GroupListResponse:',
    );

    expect(membersSection).toContain('get:');
    expect(membersSection).toContain('operationId: listGroupMembers');
    expect(membersSection).toContain('x-permission: groups.members.view');
    expect(membersSection).toContain('put:');
    expect(membersSection).toContain('operationId: replaceGroupMembers');
    expect(membersSection).toContain('x-permission: groups.members.manage');
    expect(membersSection).toContain("$ref: '#/components/schemas/ReplaceGroupMembersRequest'");
    expect(membersSection).toContain("$ref: '#/components/schemas/GroupMembersResponse'");
    expect(replaceMembersSchema).toContain('- idempotencyKey');
    expect(replaceMembersSchema).toContain('- members');
    expect(replaceMembersSchema).toContain('userId:');
    expect(replaceMembersSchema).toContain('role:');
    expect(memberSchema).toContain('employeeId:');
    expect(memberSchema).toContain('displayName:');
    expect(responseSchema).toContain('changed:');
    expect(responseSchema).toContain('auditId:');
  });

  it('documents gated group batch-link dry-run and write endpoint', () => {
    const contract = readOpenApiContract();
    const batchLinkSection = sectionBetween(
      contract,
      '  /api/v1/groups/{groupId}/batch-link:',
      '  /api/v1/groups/{groupId}/participants:',
    );
    const requestSchema = sectionBetween(
      contract,
      '    GroupBatchLinkDryRunRequest:',
      '    GroupBatchLinkDryRunResponse:',
    );
    const responseSchema = sectionBetween(
      contract,
      '    GroupBatchLinkDryRunResponse:',
      '    ReplaceGroupEntityLinksRequest:',
    );

    expect(batchLinkSection).toContain('operationId: executeGroupBatchLink');
    expect(batchLinkSection).toContain('x-permission: groups.manage_links');
    expect(batchLinkSection).toContain('x-role-codes:');
    expect(batchLinkSection).toContain('- admin');
    expect(batchLinkSection).toContain('- top_manager');
    expect(batchLinkSection).toContain('x-write-gate: BACKEND_ENABLE_GROUPS_BATCH_LINK_WRITE');
    expect(batchLinkSection).toContain("$ref: '#/components/schemas/GroupBatchLinkDryRunRequest'");
    expect(batchLinkSection).toContain("$ref: '#/components/schemas/GroupBatchLinkDryRunResponse'");
    expect(requestSchema).toContain('- mode');
    expect(requestSchema).toContain('- relationType');
    expect(requestSchema).toContain('- dry-run');
    expect(requestSchema).toContain('- write');
    expect(requestSchema).toContain('writeIntent:');
    expect(requestSchema).toContain('relationType:');
    expect(requestSchema).toContain("$ref: '#/components/schemas/GroupEntityTypeCode'");
    expect(responseSchema).toContain('writeEnabled:');
    expect(responseSchema).toContain('created:');
    expect(responseSchema).toContain('existing:');
    expect(responseSchema).toContain('action:');
    expect(responseSchema).toContain('auditId:');
    expect(responseSchema).toContain('outboxEventId:');
    expect(responseSchema).toContain('sampleEvidence:');
  });

  it('documents group report endpoints with explicit read permissions and narrow response schemas', () => {
    const contract = readOpenApiContract();
    const orderIdsSection = sectionBetween(
      contract,
      '  /api/v1/groups/reports/orders:',
      '  /api/v1/groups/reports/order-status-counts:',
    );
    const statusCountsSection = sectionBetween(
      contract,
      '  /api/v1/groups/reports/order-status-counts:',
      '  /api/v1/groups/reports/production-status-counts:',
    );
    const productionStatusCountsSection = sectionBetween(
      contract,
      '  /api/v1/groups/reports/production-status-counts:',
      '  /api/v1/groups/reports/deadline-status-counts:',
    );
    const deadlineStatusCountsSection = sectionBetween(
      contract,
      '  /api/v1/groups/reports/deadline-status-counts:',
      '  /api/v1/groups/reports/order-relation-counts:',
    );
    const relationCountsSection = sectionBetween(
      contract,
      '  /api/v1/groups/reports/order-relation-counts:',
      '  /api/v1/groups/reports/order-created-month-counts:',
    );
    const createdMonthCountsSection = sectionBetween(
      contract,
      '  /api/v1/groups/reports/order-created-month-counts:',
      '  /api/v1/groups/{groupId}:',
    );
    const statusItemSchema = sectionBetween(
      contract,
      '    GroupOrderStatusReportItem:',
      '    GroupOrderStatusReportResponse:',
    );
    const statusResponseSchema = sectionBetween(
      contract,
      '    GroupOrderStatusReportResponse:',
      '    GroupOrderStatusReportFilter:',
    );
    const statusFilterSchema = sectionBetween(
      contract,
      '    GroupOrderStatusReportFilter:',
      '    GroupProductionStatusCountsReportItem:',
    );
    const productionStatusItemSchema = sectionBetween(
      contract,
      '    GroupProductionStatusCountsReportItem:',
      '    GroupProductionStatusCountsReportResponse:',
    );
    const productionStatusResponseSchema = sectionBetween(
      contract,
      '    GroupProductionStatusCountsReportResponse:',
      '    GroupProductionStatusCountsReportFilter:',
    );
    const productionStatusFilterSchema = sectionBetween(
      contract,
      '    GroupProductionStatusCountsReportFilter:',
      '    GroupDeadlineStatusCountsReportItem:',
    );
    const deadlineStatusItemSchema = sectionBetween(
      contract,
      '    GroupDeadlineStatusCountsReportItem:',
      '    GroupDeadlineStatusCountsReportResponse:',
    );
    const deadlineStatusResponseSchema = sectionBetween(
      contract,
      '    GroupDeadlineStatusCountsReportResponse:',
      '    GroupDeadlineStatusCountsReportFilter:',
    );
    const deadlineStatusFilterSchema = sectionBetween(
      contract,
      '    GroupDeadlineStatusCountsReportFilter:',
      '    GroupOrderRelationCountsReportItem:',
    );
    const relationItemSchema = sectionBetween(
      contract,
      '    GroupOrderRelationCountsReportItem:',
      '    GroupOrderRelationCountsReportResponse:',
    );
    const relationResponseSchema = sectionBetween(
      contract,
      '    GroupOrderRelationCountsReportResponse:',
      '    GroupOrderCreatedMonthCountsReportItem:',
    );
    const createdMonthItemSchema = sectionBetween(
      contract,
      '    GroupOrderCreatedMonthCountsReportItem:',
      '    GroupOrderCreatedMonthCountsReportResponse:',
    );
    const createdMonthResponseSchema = sectionBetween(
      contract,
      '    GroupOrderCreatedMonthCountsReportResponse:',
      '    GroupOrderCreatedMonthCountsReportFilter:',
    );
    const createdMonthFilterSchema = sectionBetween(
      contract,
      '    GroupOrderCreatedMonthCountsReportFilter:',
      '    OrderListResponse:',
    );

    expect(orderIdsSection).toContain('operationId: listGroupOrderReportIds');
    expect(orderIdsSection).toContain('- groups.view');
    expect(orderIdsSection).toContain('- orders.view');
    expect(statusCountsSection).toContain('operationId: listGroupOrderStatusCounts');
    expect(statusCountsSection).toContain('- groups.view');
    expect(statusCountsSection).toContain('- orders.view');
    expect(statusCountsSection).toContain("$ref: '#/components/schemas/GroupOrderStatusReportResponse'");
    expect(productionStatusCountsSection).toContain('operationId: listGroupProductionStatusCounts');
    expect(productionStatusCountsSection).toContain('- groups.view');
    expect(productionStatusCountsSection).toContain('- orders.view');
    expect(productionStatusCountsSection).toContain("$ref: '#/components/schemas/GroupProductionStatusCountsReportResponse'");
    expect(deadlineStatusCountsSection).toContain('operationId: listGroupDeadlineStatusCounts');
    expect(deadlineStatusCountsSection).toContain('- groups.view');
    expect(deadlineStatusCountsSection).toContain('- orders.view');
    expect(deadlineStatusCountsSection).toContain('- deadlines.view');
    expect(deadlineStatusCountsSection).toContain("$ref: '#/components/schemas/GroupDeadlineStatusCountsReportResponse'");
    expect(relationCountsSection).toContain('operationId: listGroupOrderRelationCounts');
    expect(relationCountsSection).toContain('- groups.view');
    expect(relationCountsSection).toContain('- orders.view');
    expect(relationCountsSection).toContain("$ref: '#/components/schemas/GroupOrderRelationCountsReportResponse'");
    expect(createdMonthCountsSection).toContain('operationId: listGroupOrderCreatedMonthCounts');
    expect(createdMonthCountsSection).toContain('- groups.view');
    expect(createdMonthCountsSection).toContain('- orders.view');
    expect(createdMonthCountsSection).toContain("$ref: '#/components/schemas/GroupOrderCreatedMonthCountsReportResponse'");
    expect(statusItemSchema).toContain('statusId:');
    expect(statusItemSchema).toContain('statusName:');
    expect(statusItemSchema).toContain('orderCount:');
    expect(statusResponseSchema).toContain("$ref: '#/components/schemas/GroupOrderStatusReportFilter'");
    expect(statusFilterSchema).toContain('oneOf:');
    expect(statusFilterSchema).toContain('- groupIds');
    expect(statusFilterSchema).toContain('- asOf');
    expect(statusFilterSchema).toContain('- from');
    expect(statusFilterSchema).toContain('- to');
    expect(statusFilterSchema).toContain('additionalProperties: false');
    expect(statusFilterSchema).toContain('groupMode:');
    expect(statusFilterSchema).toContain('temporalMode:');
    expect(statusResponseSchema).not.toContain('pagination:');
    expect(statusResponseSchema).not.toContain('orderId:');
    expect(statusResponseSchema).not.toContain('client');
    expect(statusResponseSchema).not.toContain('payment');
    expect(statusResponseSchema).not.toContain('deadline');
    expect(statusResponseSchema).not.toContain('audit');
    expect(productionStatusItemSchema).toContain('productionStatusId:');
    expect(productionStatusItemSchema).toContain('nullable: true');
    expect(productionStatusItemSchema).toContain('productionStatusCode:');
    expect(productionStatusItemSchema).toContain('productionStatusName:');
    expect(productionStatusItemSchema).toContain('orderCount:');
    expect(productionStatusItemSchema).toContain('additionalProperties: false');
    expect(productionStatusResponseSchema).toContain('additionalProperties: false');
    expect(productionStatusResponseSchema).toContain("$ref: '#/components/schemas/GroupProductionStatusCountsReportFilter'");
    expect(productionStatusFilterSchema).toContain('oneOf:');
    expect(productionStatusFilterSchema).toContain('- groupMode');
    expect(productionStatusFilterSchema).toContain('- groupIds');
    expect(productionStatusFilterSchema).toContain('- temporalMode');
    expect(productionStatusFilterSchema).toContain('enum: [current]');
    expect(productionStatusFilterSchema).toContain('additionalProperties: false');
    expect(productionStatusCountsSection).not.toContain('name: asOf');
    expect(productionStatusCountsSection).not.toContain('name: from');
    expect(productionStatusCountsSection).not.toContain('name: to');
    expect(productionStatusFilterSchema).not.toContain('- asOf');
    expect(productionStatusFilterSchema).not.toContain('- from');
    expect(productionStatusFilterSchema).not.toContain('- to');
    expect(productionStatusResponseSchema).not.toContain('pagination:');
    expect(productionStatusResponseSchema).not.toContain('orderId:');
    expect(deadlineStatusItemSchema).toContain('deadlineStatus:');
    expect(deadlineStatusItemSchema).toContain('enum: [active, paused, expired, completed_on_time, completed_late, cancelled, superseded]');
    expect(deadlineStatusItemSchema).toContain('deadlineCount:');
    expect(deadlineStatusItemSchema).toContain('additionalProperties: false');
    expect(deadlineStatusResponseSchema).toContain('additionalProperties: false');
    expect(deadlineStatusResponseSchema).toContain("$ref: '#/components/schemas/GroupDeadlineStatusCountsReportFilter'");
    expect(deadlineStatusFilterSchema).toContain('oneOf:');
    expect(deadlineStatusFilterSchema).toContain('- groupMode');
    expect(deadlineStatusFilterSchema).toContain('- groupIds');
    expect(deadlineStatusFilterSchema).toContain('- temporalMode');
    expect(deadlineStatusFilterSchema).toContain('enum: [current]');
    expect(deadlineStatusFilterSchema).toContain('additionalProperties: false');
    expect(deadlineStatusFilterSchema).toContain('enum: [any, all]');
    expect(deadlineStatusFilterSchema).not.toContain('primary');
    expect(deadlineStatusCountsSection).not.toContain('name: asOf');
    expect(deadlineStatusCountsSection).not.toContain('name: from');
    expect(deadlineStatusCountsSection).not.toContain('name: to');
    expect(deadlineStatusResponseSchema).not.toContain('pagination:');
    expect(deadlineStatusResponseSchema).not.toContain('deadlineId:');
    expect(deadlineStatusResponseSchema).not.toContain('orderId:');
    expect(deadlineStatusResponseSchema).not.toContain('groupName:');
    expect(relationItemSchema).toContain('relationType:');
    expect(relationItemSchema).toContain('enum: [main, secondary, reporting, billing, derived]');
    expect(relationItemSchema).toContain('isPrimary:');
    expect(relationItemSchema).toContain('orderCount:');
    expect(relationItemSchema).toContain('additionalProperties: false');
    expect(relationResponseSchema).toContain('additionalProperties: false');
    expect(relationResponseSchema).toContain("$ref: '#/components/schemas/GroupOrderStatusReportFilter'");
    expect(createdMonthItemSchema).toContain('month:');
    expect(createdMonthItemSchema).toContain('format: date');
    expect(createdMonthItemSchema).toContain('orderCount:');
    expect(createdMonthItemSchema).toContain('additionalProperties: false');
    expect(createdMonthResponseSchema).toContain('additionalProperties: false');
    expect(createdMonthResponseSchema).toContain("$ref: '#/components/schemas/GroupOrderCreatedMonthCountsReportFilter'");
    expect(createdMonthFilterSchema).toContain('oneOf:');
    expect(createdMonthFilterSchema).toContain('createdFrom:');
    expect(createdMonthFilterSchema).toContain('createdTo:');
    expect(createdMonthFilterSchema).toContain('additionalProperties: false');
    expect(relationResponseSchema).not.toContain('pagination:');
    expect(relationResponseSchema).not.toContain('orderId:');
    expect(createdMonthResponseSchema).not.toContain('pagination:');
    expect(createdMonthResponseSchema).not.toContain('orderId:');
    for (const leakedToken of [
      'amount',
      'payment',
      'client',
      'deadline',
      'production',
      'audit',
      'production_status_events',
      'group_members',
      'members:',
      'employeeId',
      'displayName',
      'phone',
      'email',
      'orderId',
    ]) {
      expect(relationCountsSection).not.toContain(leakedToken);
      expect(relationItemSchema).not.toContain(leakedToken);
      expect(relationResponseSchema).not.toContain(leakedToken);
      expect(createdMonthCountsSection).not.toContain(leakedToken);
      expect(createdMonthItemSchema).not.toContain(leakedToken);
      expect(createdMonthResponseSchema).not.toContain(leakedToken);
    }

    for (const leakedToken of [
      'amount',
      'payment',
      'client',
      'deadline',
      'audit',
      'production_status_events',
      'group_members',
      'members:',
      'employeeId',
      'displayName',
      'phone',
      'email',
      'orderId',
    ]) {
      expect(productionStatusCountsSection).not.toContain(leakedToken);
      expect(productionStatusItemSchema).not.toContain(leakedToken);
      expect(productionStatusResponseSchema).not.toContain(leakedToken);
    }

    for (const leakedToken of [
      'amount',
      'payment',
      'client',
      'audit',
      'production_status_events',
      'group_members',
      'members:',
      'employeeId',
      'displayName',
      'phone',
      'email',
      'deadlineId',
      'orderId',
      'groupId:',
      'groupName',
      'metadata',
      'notification',
      'actionExecution',
    ]) {
      expect(deadlineStatusCountsSection).not.toContain(leakedToken);
      expect(deadlineStatusItemSchema).not.toContain(leakedToken);
      expect(deadlineStatusResponseSchema).not.toContain(leakedToken);
    }
  });

  it('documents group overview with narrow response schemas and no domain leaks', () => {
    const contract = readOpenApiContract();
    const overviewSection = sectionBetween(
      contract,
      '  /api/v1/groups/{groupId}/overview:',
      '  /api/v1/groups/{groupId}:',
    );
    const responseSchema = sectionBetween(
      contract,
      '    GroupOverviewResponse:',
      '    GroupOverviewGroup:',
    );
    const groupSchema = sectionBetween(
      contract,
      '    GroupOverviewGroup:',
      '    GroupOverviewOrders:',
    );
    const ordersSchema = sectionBetween(
      contract,
      '    GroupOverviewOrders:',
      '    GroupOverviewStatusCount:',
    );
    const statusCountSchema = sectionBetween(
      contract,
      '    GroupOverviewStatusCount:',
      '    GroupOverviewRelationCount:',
    );
    const relationCountSchema = sectionBetween(
      contract,
      '    GroupOverviewRelationCount:',
      '    GroupOverviewCreatedMonthCount:',
    );
    const createdMonthCountSchema = sectionBetween(
      contract,
      '    GroupOverviewCreatedMonthCount:',
      '    GroupOverviewFilter:',
    );
    const filterSchema = sectionBetween(
      contract,
      '    GroupOverviewFilter:',
      '    MdfBoardManualMoveTargetColumn:',
    );

    expect(overviewSection).toContain('operationId: getGroupOverview');
    expect(overviewSection).toContain('- groups.view');
    expect(overviewSection).toContain('- orders.view');
    expect(overviewSection).toContain("$ref: '#/components/schemas/GroupOverviewResponse'");
    expect(overviewSection).toContain('format: uuid');
    expect(overviewSection).toContain('enum: [current, asOf, overlap]');
    expect(overviewSection).toContain('default: current');
    expect(queryParameterNames(overviewSection)).toEqual([
      'temporalMode',
      'asOf',
      'from',
      'to',
      'createdFrom',
      'createdTo',
    ]);
    expect(overviewSection).not.toContain('name: groupIds');

    for (const schema of [
      responseSchema,
      groupSchema,
      ordersSchema,
      statusCountSchema,
      relationCountSchema,
      createdMonthCountSchema,
      filterSchema,
    ]) {
      expect(schema).toContain('additionalProperties: false');
    }

    expect(groupSchema).toContain('ownerUserId:');
    expect(groupSchema).not.toContain('metadata:');
    expect(groupSchema).not.toContain('createdBy:');
    expect(ordersSchema).toContain('totalCount:');
    expect(ordersSchema).toContain('statusCounts:');
    expect(ordersSchema).toContain('relationCounts:');
    expect(ordersSchema).toContain('createdMonthCounts:');
    expect(statusCountSchema).toContain('statusId:');
    expect(relationCountSchema).toContain('relationType:');
    expect(createdMonthCountSchema).toContain('format: date');
    expect(filterSchema).toContain('oneOf:');
    expect(filterSchema).toContain('groupId:');
    expect(filterSchema).toContain('createdFrom:');
    expect(filterSchema).toContain('createdTo:');
    expect(responseSchema).toContain('enum: [finance, payments, clientPhones, audit, deadline, production, members, users, orderDetails, activityTimeline]');

    for (const leakedToken of [
      'Payment',
      'Deadline',
      'Production',
      'Audit',
      'GroupMember',
      'OrderDetails',
      'ClientPhone',
      'amount',
      'phone',
      'employeeId',
      'displayName',
      'email',
      'metadata',
      'createdBy',
    ]) {
      expect(overviewSection).not.toContain(leakedToken);
      expect(responseSchema).not.toContain(leakedToken);
      expect(groupSchema).not.toContain(leakedToken);
      expect(ordersSchema).not.toContain(leakedToken);
      expect(statusCountSchema).not.toContain(leakedToken);
      expect(relationCountSchema).not.toContain(leakedToken);
      expect(createdMonthCountSchema).not.toContain(leakedToken);
      expect(filterSchema).not.toContain(leakedToken);
    }
  });
});

function readOpenApiContract(): string {
  const candidates = [
    resolve(process.cwd(), 'backend/contracts/04-api-contract.openapi.yaml'),
    resolve(process.cwd(), 'contracts/04-api-contract.openapi.yaml'),
  ];
  const contractPath = candidates.find((candidate) => existsSync(candidate));

  expect(contractPath).toBeDefined();

  return readFileSync(contractPath as string, 'utf8');
}

function sectionBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);

  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);

  return source.slice(startIndex, endIndex);
}

function queryParameterNames(section: string): string[] {
  return [...section.matchAll(/^\s{8}- name: ([^\n]+)\n\s{10}in: query$/gm)].map((match) => match[1]);
}
