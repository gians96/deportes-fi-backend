import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SetStatusDto } from './set-status.dto';

async function errorsOf(payload: Record<string, unknown>) {
  return validate(plainToInstance(SetStatusDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: false,
  });
}

describe('SetStatusDto', () => {
  it.each(['PENDING', 'APPROVED', 'REJECTED', 'OBSERVED', 'CANCELLED'])(
    'acepta %s',
    async (status) => {
      expect(await errorsOf({ status })).toHaveLength(0);
    },
  );

  it.each(['DRAFT', 'pending', '', 'OTRO'])('rechaza %j', async (status) => {
    expect(await errorsOf({ status })).not.toHaveLength(0);
  });

  it('exige el estado y limita el motivo a 500 caracteres', async () => {
    expect(await errorsOf({})).not.toHaveLength(0);
    expect(
      await errorsOf({ status: 'OBSERVED', reason: 'x'.repeat(500) }),
    ).toHaveLength(0);
    expect(
      await errorsOf({ status: 'OBSERVED', reason: 'x'.repeat(501) }),
    ).not.toHaveLength(0);
  });
});
