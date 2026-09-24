import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_PERMISSIONS_METADATA_KEY } from '../../permissions/require-permissions.decorator';
import { DailyDigestController } from './daily-digest.controller';
import { ApiError } from '../../common/errors/api-error';

const expected=['whatsapp.manage','calendar.view','orders.view','orders.view_financials'];

describe('daily digest controller permission gates',()=>{
  it.each(['settings','updateSettings','preview','createRun','runs','run','image','retry'] as const)(
    '%s requires every image-scope permission',method=>{
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS_METADATA_KEY,DailyDigestController.prototype[method]))
        .toEqual(expected);
    },
  );

  it('allows page 500 and rejects page 501 before service lookup',async()=>{
    const service={image:vi.fn().mockResolvedValue({bytes:Buffer.from('png')})};
    const controller=new DailyDigestController(service as never);
    const response={type:vi.fn().mockReturnThis(),setHeader:vi.fn().mockReturnThis(),send:vi.fn().mockReturnThis()};
    const runId='5b842f1b-21ae-47b6-a4ee-cd89e4261c34';
    await controller.image(runId,'500',response as never);
    expect(service.image).toHaveBeenCalledWith(runId,500);
    await expect(controller.image(runId,'501',response as never)).rejects.toBeInstanceOf(ApiError);
    expect(service.image).toHaveBeenCalledTimes(1);
  });
});
