import { BadRequestException } from '@nestjs/common';
import { assertGroupRoster } from './group-roster';

const member = (overrides: Record<string, unknown> = {}) => ({
  fullName: 'ALUMNO UNO',
  studentCode: '2301010149',
  dni: '71234567',
  isCaptain: false,
  ...overrides,
});

describe('assertGroupRoster', () => {
  it('acepta una nómina completa con un capitán', () => {
    expect(() =>
      assertGroupRoster([
        member({ isCaptain: true }),
        member({
          fullName: 'ALUMNO DOS',
          studentCode: '2301010150',
          dni: '71234568',
        }),
      ]),
    ).not.toThrow();
  });

  it('exige el código de estudiante de cada integrante', () => {
    expect(() =>
      assertGroupRoster([member({ studentCode: ' ', isCaptain: true })]),
    ).toThrow('Falta el código de estudiante de ALUMNO UNO');
    expect(() =>
      assertGroupRoster([member({ studentCode: null, isCaptain: true })]),
    ).toThrow(BadRequestException);
  });

  it.each([null, undefined, '', '1234567', '123456789', '7123456a'])(
    'rechaza el DNI %j',
    (dni) => {
      expect(() =>
        assertGroupRoster([member({ dni, isCaptain: true })]),
      ).toThrow('Falta el DNI (8 dígitos) de ALUMNO UNO');
    },
  );

  it('rechaza DNI repetidos dentro del equipo', () => {
    expect(() =>
      assertGroupRoster([
        member({ isCaptain: true }),
        member({ fullName: 'ALUMNO DOS', studentCode: '2301010150' }),
      ]),
    ).toThrow('DNI repetido en el equipo: ALUMNO DOS');
  });

  it('exige exactamente un capitán', () => {
    expect(() => assertGroupRoster([member()])).toThrow(
      'Designa un capitán/a del equipo',
    );
    expect(() =>
      assertGroupRoster([
        member({ isCaptain: true }),
        member({
          fullName: 'ALUMNO DOS',
          studentCode: '2301010150',
          dni: '71234568',
          isCaptain: true,
        }),
      ]),
    ).toThrow('hay más de uno');
  });

  it('reporta primero el integrante incompleto antes que la falta de capitán', () => {
    expect(() => assertGroupRoster([member({ dni: null })])).toThrow(
      'Falta el DNI',
    );
  });
});
