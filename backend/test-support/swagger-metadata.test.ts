import { describe, expect, it } from 'vitest';
import { inspectSwaggerMetadata } from './swagger-metadata';

describe('Swagger metadata discovery', () => {
  it('associates metadata with its own method across long bodies and decorator ordering', () => {
    const source = `
      @ApiTags('Example') @Controller('example') class Example {
        @ApiOperation({ summary: 'Long body' })
        @ApiBody({ schema: { properties: { ${'field: {},\n'.repeat(40)} } } })
        @Post('long') long() {}
        @Get('after') @ApiOperation({ summary: 'After route' }) after() {}
        @Get('missing') missing() {}
      }
    `;
    const result = inspectSwaggerMetadata(source);
    expect(result.controllerCount).toBe(1);
    expect(result.missingTags).toEqual([]);
    expect(result.missingOperations).toHaveLength(1);
    expect(result.missingOperations[0]).toContain('Example.missing:');
  });

  it('does not borrow tags/operations from comments, adjacent methods or another controller', () => {
    const result = inspectSwaggerMetadata(`
      @ApiTags('Tagged') @Controller('one') class One {
        @ApiOperation({ summary: 'Documented' }) @Get() get() {}
        // @ApiOperation({ summary: 'Only a comment' })
        @Post() post() {}
      }
      // @ApiTags('Only a comment')
      @Controller('two') class Two { @Get() get() {} }
    `);
    expect(result.controllerCount).toBe(2);
    expect(result.missingTags).toEqual(['Two']);
    expect(result.missingOperations).toHaveLength(2);
    expect(result.missingOperations[0]).toContain('One.post:');
    expect(result.missingOperations[1]).toContain('Two.get:');
  });

  it('honors runtime controller exclusion without excluding explicit false', () => {
    const result = inspectSwaggerMetadata(`
      @ApiExcludeController() @Controller('hidden') class Hidden { @Get() get() {} }
      @ApiExcludeController(true) @Controller('also-hidden') class AlsoHidden { @Get() get() {} }
      @ApiExcludeController(false) @Controller('visible') class Visible { @Get() get() {} }
    `);
    expect(result.controllerCount).toBe(3);
    expect(result.missingTags).toEqual(['Visible']);
    expect(result.missingOperations).toHaveLength(1);
    expect(result.missingOperations[0]).toContain('Visible.get:');
  });
});
