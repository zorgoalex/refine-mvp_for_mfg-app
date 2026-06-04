import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('projects OpenAPI contract', () => {
  it('declares project routes and top-level Projects tag', () => {
    const contract = readOpenApiContract();
    const tagsSection = sectionBetween(contract, 'tags:\n', '\npaths:');

    expect(tagsSection).toContain('  - name: Projects');
    expect(contract).toContain('  /api/v1/projects:');
    expect(contract).toContain('  /api/v1/projects/lookup:');
    expect(contract).toContain('  /api/v1/projects/{projectId}:');
    expect(contract).toContain('  /api/v1/projects/{projectId}/members:');
    expect(contract).toContain('  /api/v1/projects/reports/orders:');
    expect(contract).toContain('  /api/v1/projects/reports/order-status-counts:');
    expect(contract).toContain('  /api/v1/projects/reports/production-status-counts:');
    expect(contract).toContain('  /api/v1/projects/reports/order-relation-counts:');
    expect(contract).toContain('  /api/v1/projects/reports/order-created-month-counts:');
    expect(contract).toContain('  /api/v1/projects/{projectId}/overview:');
  });

  it('documents get project bad request and list pagination totalPages', () => {
    const contract = readOpenApiContract();
    const listSection = sectionBetween(
      contract,
      '  /api/v1/projects:',
      '  /api/v1/projects/lookup:',
    );
    const getSection = sectionBetween(
      contract,
      '  /api/v1/projects/{projectId}:',
      '  /api/v1/users:',
    );
    const listResponseSchema = sectionBetween(
      contract,
      '    ProjectListResponse:',
      '    Pagination:',
    );

    expect(listSection).toContain("$ref: '#/components/schemas/ProjectListResponse'");
    expect(listResponseSchema).toContain('- totalPages');
    expect(listResponseSchema).toContain('totalPages:');
    expect(getSection).toContain("'400':");
    expect(getSection).toContain("$ref: '#/components/responses/BadRequest'");
  });

  it('documents project write endpoints, permissions, and request schemas', () => {
    const contract = readOpenApiContract();
    const projectsSection = sectionBetween(
      contract,
      '  /api/v1/projects:',
      '  /api/v1/projects/lookup:',
    );
    const projectByIdSection = sectionBetween(
      contract,
      '  /api/v1/projects/{projectId}:',
      '  /api/v1/users:',
    );
    const createSchema = sectionBetween(
      contract,
      '    CreateProjectRequest:',
      '    UpdateProjectRequest:',
    );
    const updateSchema = sectionBetween(
      contract,
      '    UpdateProjectRequest:',
      '    Project:',
    );

    expect(projectsSection).toContain('post:');
    expect(projectsSection).toContain('operationId: createProject');
    expect(projectsSection).toContain('x-permission: projects.create');
    expect(projectsSection).toContain("$ref: '#/components/schemas/CreateProjectRequest'");
    expect(projectByIdSection).toContain('patch:');
    expect(projectByIdSection).toContain('operationId: updateProject');
    expect(projectByIdSection).toContain('x-permission: projects.update');
    expect(projectByIdSection).toContain('delete:');
    expect(projectByIdSection).toContain('operationId: archiveProject');
    expect(projectByIdSection).toContain('x-permission: projects.archive');
    expect(createSchema).toContain('- code');
    expect(createSchema).toContain('pattern: ^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$');
    expect(createSchema).toContain('maxLength: 256');
    expect(updateSchema).toContain('minProperties: 1');
    expect(createSchema).toContain('enum: [draft, active, paused, completed]');
    expect(updateSchema).toContain('enum: [draft, active, paused, completed]');
    expect(updateSchema).not.toContain('enum: [draft, active, paused, completed, archived]');
  });

  it('documents project members GET and PUT endpoints with explicit members permissions', () => {
    const contract = readOpenApiContract();
    const membersSection = sectionBetween(
      contract,
      '  /api/v1/projects/{projectId}/members:',
      '  /api/v1/users:',
    );
    const replaceMembersSchema = sectionBetween(
      contract,
      '    ReplaceProjectMembersRequest:',
      '    ProjectMember:',
    );
    const memberSchema = sectionBetween(
      contract,
      '    ProjectMember:',
      '    ProjectMembersResponse:',
    );
    const responseSchema = sectionBetween(
      contract,
      '    ProjectMembersResponse:',
      '    ProjectListResponse:',
    );

    expect(membersSection).toContain('get:');
    expect(membersSection).toContain('operationId: listProjectMembers');
    expect(membersSection).toContain('x-permission: projects.members.view');
    expect(membersSection).toContain('put:');
    expect(membersSection).toContain('operationId: replaceProjectMembers');
    expect(membersSection).toContain('x-permission: projects.members.manage');
    expect(membersSection).toContain("$ref: '#/components/schemas/ReplaceProjectMembersRequest'");
    expect(membersSection).toContain("$ref: '#/components/schemas/ProjectMembersResponse'");
    expect(replaceMembersSchema).toContain('- idempotencyKey');
    expect(replaceMembersSchema).toContain('- members');
    expect(replaceMembersSchema).toContain('userId:');
    expect(replaceMembersSchema).toContain('role:');
    expect(memberSchema).toContain('employeeId:');
    expect(memberSchema).toContain('displayName:');
    expect(responseSchema).toContain('changed:');
    expect(responseSchema).toContain('auditId:');
  });

  it('documents project report endpoints with explicit read permissions and narrow response schemas', () => {
    const contract = readOpenApiContract();
    const orderIdsSection = sectionBetween(
      contract,
      '  /api/v1/projects/reports/orders:',
      '  /api/v1/projects/reports/order-status-counts:',
    );
    const statusCountsSection = sectionBetween(
      contract,
      '  /api/v1/projects/reports/order-status-counts:',
      '  /api/v1/projects/reports/production-status-counts:',
    );
    const productionStatusCountsSection = sectionBetween(
      contract,
      '  /api/v1/projects/reports/production-status-counts:',
      '  /api/v1/projects/reports/order-relation-counts:',
    );
    const relationCountsSection = sectionBetween(
      contract,
      '  /api/v1/projects/reports/order-relation-counts:',
      '  /api/v1/projects/reports/order-created-month-counts:',
    );
    const createdMonthCountsSection = sectionBetween(
      contract,
      '  /api/v1/projects/reports/order-created-month-counts:',
      '  /api/v1/projects/{projectId}:',
    );
    const statusItemSchema = sectionBetween(
      contract,
      '    ProjectOrderStatusReportItem:',
      '    ProjectOrderStatusReportResponse:',
    );
    const statusResponseSchema = sectionBetween(
      contract,
      '    ProjectOrderStatusReportResponse:',
      '    ProjectOrderStatusReportFilter:',
    );
    const statusFilterSchema = sectionBetween(
      contract,
      '    ProjectOrderStatusReportFilter:',
      '    ProjectProductionStatusCountsReportItem:',
    );
    const productionStatusItemSchema = sectionBetween(
      contract,
      '    ProjectProductionStatusCountsReportItem:',
      '    ProjectProductionStatusCountsReportResponse:',
    );
    const productionStatusResponseSchema = sectionBetween(
      contract,
      '    ProjectProductionStatusCountsReportResponse:',
      '    ProjectProductionStatusCountsReportFilter:',
    );
    const productionStatusFilterSchema = sectionBetween(
      contract,
      '    ProjectProductionStatusCountsReportFilter:',
      '    ProjectOrderRelationCountsReportItem:',
    );
    const relationItemSchema = sectionBetween(
      contract,
      '    ProjectOrderRelationCountsReportItem:',
      '    ProjectOrderRelationCountsReportResponse:',
    );
    const relationResponseSchema = sectionBetween(
      contract,
      '    ProjectOrderRelationCountsReportResponse:',
      '    ProjectOrderCreatedMonthCountsReportItem:',
    );
    const createdMonthItemSchema = sectionBetween(
      contract,
      '    ProjectOrderCreatedMonthCountsReportItem:',
      '    ProjectOrderCreatedMonthCountsReportResponse:',
    );
    const createdMonthResponseSchema = sectionBetween(
      contract,
      '    ProjectOrderCreatedMonthCountsReportResponse:',
      '    ProjectOrderCreatedMonthCountsReportFilter:',
    );
    const createdMonthFilterSchema = sectionBetween(
      contract,
      '    ProjectOrderCreatedMonthCountsReportFilter:',
      '    OrderListResponse:',
    );

    expect(orderIdsSection).toContain('operationId: listProjectOrderReportIds');
    expect(orderIdsSection).toContain('- projects.view');
    expect(orderIdsSection).toContain('- orders.view');
    expect(statusCountsSection).toContain('operationId: listProjectOrderStatusCounts');
    expect(statusCountsSection).toContain('- projects.view');
    expect(statusCountsSection).toContain('- orders.view');
    expect(statusCountsSection).toContain("$ref: '#/components/schemas/ProjectOrderStatusReportResponse'");
    expect(productionStatusCountsSection).toContain('operationId: listProjectProductionStatusCounts');
    expect(productionStatusCountsSection).toContain('- projects.view');
    expect(productionStatusCountsSection).toContain('- orders.view');
    expect(productionStatusCountsSection).toContain("$ref: '#/components/schemas/ProjectProductionStatusCountsReportResponse'");
    expect(relationCountsSection).toContain('operationId: listProjectOrderRelationCounts');
    expect(relationCountsSection).toContain('- projects.view');
    expect(relationCountsSection).toContain('- orders.view');
    expect(relationCountsSection).toContain("$ref: '#/components/schemas/ProjectOrderRelationCountsReportResponse'");
    expect(createdMonthCountsSection).toContain('operationId: listProjectOrderCreatedMonthCounts');
    expect(createdMonthCountsSection).toContain('- projects.view');
    expect(createdMonthCountsSection).toContain('- orders.view');
    expect(createdMonthCountsSection).toContain("$ref: '#/components/schemas/ProjectOrderCreatedMonthCountsReportResponse'");
    expect(statusItemSchema).toContain('statusId:');
    expect(statusItemSchema).toContain('statusName:');
    expect(statusItemSchema).toContain('orderCount:');
    expect(statusResponseSchema).toContain("$ref: '#/components/schemas/ProjectOrderStatusReportFilter'");
    expect(statusFilterSchema).toContain('oneOf:');
    expect(statusFilterSchema).toContain('- projectIds');
    expect(statusFilterSchema).toContain('- asOf');
    expect(statusFilterSchema).toContain('- from');
    expect(statusFilterSchema).toContain('- to');
    expect(statusFilterSchema).toContain('additionalProperties: false');
    expect(statusFilterSchema).toContain('projectMode:');
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
    expect(productionStatusResponseSchema).toContain("$ref: '#/components/schemas/ProjectProductionStatusCountsReportFilter'");
    expect(productionStatusFilterSchema).toContain('oneOf:');
    expect(productionStatusFilterSchema).toContain('- projectMode');
    expect(productionStatusFilterSchema).toContain('- projectIds');
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
    expect(relationItemSchema).toContain('relationType:');
    expect(relationItemSchema).toContain('enum: [main, secondary, reporting, billing, derived]');
    expect(relationItemSchema).toContain('isPrimary:');
    expect(relationItemSchema).toContain('orderCount:');
    expect(relationItemSchema).toContain('additionalProperties: false');
    expect(relationResponseSchema).toContain('additionalProperties: false');
    expect(relationResponseSchema).toContain("$ref: '#/components/schemas/ProjectOrderStatusReportFilter'");
    expect(createdMonthItemSchema).toContain('month:');
    expect(createdMonthItemSchema).toContain('format: date');
    expect(createdMonthItemSchema).toContain('orderCount:');
    expect(createdMonthItemSchema).toContain('additionalProperties: false');
    expect(createdMonthResponseSchema).toContain('additionalProperties: false');
    expect(createdMonthResponseSchema).toContain("$ref: '#/components/schemas/ProjectOrderCreatedMonthCountsReportFilter'");
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
      'project_members',
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
      'project_members',
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
  });

  it('documents project overview with narrow response schemas and no domain leaks', () => {
    const contract = readOpenApiContract();
    const overviewSection = sectionBetween(
      contract,
      '  /api/v1/projects/{projectId}/overview:',
      '  /api/v1/projects/{projectId}:',
    );
    const responseSchema = sectionBetween(
      contract,
      '    ProjectOverviewResponse:',
      '    ProjectOverviewProject:',
    );
    const projectSchema = sectionBetween(
      contract,
      '    ProjectOverviewProject:',
      '    ProjectOverviewOrders:',
    );
    const ordersSchema = sectionBetween(
      contract,
      '    ProjectOverviewOrders:',
      '    ProjectOverviewStatusCount:',
    );
    const statusCountSchema = sectionBetween(
      contract,
      '    ProjectOverviewStatusCount:',
      '    ProjectOverviewRelationCount:',
    );
    const relationCountSchema = sectionBetween(
      contract,
      '    ProjectOverviewRelationCount:',
      '    ProjectOverviewCreatedMonthCount:',
    );
    const createdMonthCountSchema = sectionBetween(
      contract,
      '    ProjectOverviewCreatedMonthCount:',
      '    ProjectOverviewFilter:',
    );
    const filterSchema = sectionBetween(
      contract,
      '    ProjectOverviewFilter:',
      '    OrderListResponse:',
    );

    expect(overviewSection).toContain('operationId: getProjectOverview');
    expect(overviewSection).toContain('- projects.view');
    expect(overviewSection).toContain('- orders.view');
    expect(overviewSection).toContain("$ref: '#/components/schemas/ProjectOverviewResponse'");
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
    expect(overviewSection).not.toContain('name: projectIds');

    for (const schema of [
      responseSchema,
      projectSchema,
      ordersSchema,
      statusCountSchema,
      relationCountSchema,
      createdMonthCountSchema,
      filterSchema,
    ]) {
      expect(schema).toContain('additionalProperties: false');
    }

    expect(projectSchema).toContain('ownerUserId:');
    expect(projectSchema).not.toContain('metadata:');
    expect(projectSchema).not.toContain('createdBy:');
    expect(ordersSchema).toContain('totalCount:');
    expect(ordersSchema).toContain('statusCounts:');
    expect(ordersSchema).toContain('relationCounts:');
    expect(ordersSchema).toContain('createdMonthCounts:');
    expect(statusCountSchema).toContain('statusId:');
    expect(relationCountSchema).toContain('relationType:');
    expect(createdMonthCountSchema).toContain('format: date');
    expect(filterSchema).toContain('oneOf:');
    expect(filterSchema).toContain('projectId:');
    expect(filterSchema).toContain('createdFrom:');
    expect(filterSchema).toContain('createdTo:');
    expect(responseSchema).toContain('enum: [finance, payments, clientPhones, audit, deadline, production, members, users, orderDetails, activityTimeline]');

    for (const leakedToken of [
      'Payment',
      'Deadline',
      'Production',
      'Audit',
      'ProjectMember',
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
      expect(projectSchema).not.toContain(leakedToken);
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
