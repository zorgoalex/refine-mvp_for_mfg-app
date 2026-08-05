import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { describe, expect, it } from 'vitest';
import { BazisCutService } from '../application/bazis-cut.service';
import { BazisCutSetsController } from './bazis-cut-sets.controller';
import { BazisCutRuntimeConfigService } from './bazis-cut-runtime-config.service';

const backendRoot = existsSync(resolve(process.cwd(), 'backend/contracts'))
  ? resolve(process.cwd(), 'backend')
  : process.cwd();
const contract = readFileSync(resolve(backendRoot, 'contracts/04-api-contract.openapi.yaml'), 'utf8');
const controller = readFileSync(resolve(backendRoot, 'src/modules/bazis-cut/http/bazis-cut-sets.controller.ts'), 'utf8');

@Module({ controllers: [BazisCutSetsController], providers: [
  { provide: BazisCutService, useValue: {} }, { provide: BazisCutRuntimeConfigService, useValue: {} },
] })
class SwaggerTestModule {}

describe('Bazis-cut OpenAPI contract', () => {
  it('declares path ids, idempotency headers, command bodies and binary XLS response', () => {
    for (const token of [
      'BazisCutSetId:', 'BazisCutSetDetailId:', "#/components/parameters/IdempotencyKey",
      'CreateBazisCutSetRequest', 'RenameBazisCutSetRequest', 'AddBazisCutDetailsRequest',
      'UpdateBazisCutDetailRequest', 'DeleteBazisCutDetailRequest', 'BazisCutMutationResult',
      'application/vnd.ms-excel', 'format: binary',
    ]) expect(contract).toContain(token);
    expect(contract.match(/name: setId/g)?.length).toBeGreaterThanOrEqual(1);
    expect(contract.match(/required: \[cutEnabled,[\s\S]*?film\]/)?.[0]).toContain('priority');
    expect(contract).toContain('position: { type: string }');
    expect(contract).toContain('required: [orderId, detailIds]');
    expect(contract).not.toContain('required: [name, orderId, detailIds]');
  });

  it('keeps matching Swagger metadata on every command route', () => {
    expect(controller.match(/@ApiHeader\(commandHeader\)/g)).toHaveLength(5);
    expect(controller.match(/@ApiParam\(idParameter\)/g)).toHaveLength(6);
    expect(controller).toContain("@ApiProduces('application/vnd.ms-excel')");
    expect(controller).toContain("description: 'Strict full replacement: all 33 editable Basis fields plus expectedVersion'");
    expect(controller.match(/@ApiQuery\(/g)).toHaveLength(3);
    expect(controller).toContain('additionalProperties: false');
  });

  it('generates strict 33-field request and JSON response schemas at runtime', async () => {
    const app = await NestFactory.create(SwaggerTestModule, { logger: false });
    try {
      const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
      const list = document.paths['/bazis-cut-sets']?.get;
      expect(list?.parameters?.map((parameter) => 'name' in parameter ? parameter.name : '')).toEqual(
        expect.arrayContaining(['search', 'page', 'pageSize']),
      );
      expect(list?.responses?.['200']?.content?.['application/json']?.schema).toBeDefined();

      const create = document.paths['/bazis-cut-sets']?.post;
      const createSchema = create?.requestBody && 'content' in create.requestBody
        ? create.requestBody.content['application/json']?.schema
        : undefined;
      expect(createSchema && 'required' in createSchema ? createSchema.required : [])
        .toEqual(['orderId', 'detailIds']);

      const update = document.paths['/bazis-cut-sets/{setId}/details/{detailId}']?.patch;
      const schema = update?.requestBody && 'content' in update.requestBody
        ? update.requestBody.content['application/json']?.schema
        : undefined;
      expect(schema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(schema && 'required' in schema ? schema.required : []).toEqual(
        expect.arrayContaining(['cutEnabled', 'materialName', 'position', 'priority', 'film', 'expectedVersion']),
      );
      expect(schema && 'properties' in schema ? Object.keys(schema.properties ?? {}) : []).toHaveLength(34);
      const position = schema && 'properties' in schema ? schema.properties?.position : undefined;
      expect(position).toMatchObject({ type: 'string' });
      expect(position).not.toHaveProperty('minLength');
      expect(position).not.toHaveProperty('maxLength');
      expect(update?.responses?.['200']?.content?.['application/json']?.schema).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
