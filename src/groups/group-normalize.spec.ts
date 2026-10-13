import { BadRequestException } from '@nestjs/common';
import {
  CYCLE_FULL_SECTION,
  groupLabel,
  normalizeCycle,
  normalizeSection,
} from './group-normalize';

describe('normalizeCycle', () => {
  it.each([
    ['5', 'V'],
    ['V', 'V'],
    [' v ', 'V'],
    ['ciclo V', 'V'],
    ['v ciclo', 'V'],
    ['Ciclo 5', 'V'],
    ['5to', 'V'],
    ['5to ciclo', 'V'],
    ['1', 'I'],
    ['10', 'X'],
    ['x', 'X'],
    ['viii', 'VIII'],
    ['12', 'XII'],
  ])('normaliza %j a %s', (input, expected) => {
    expect(normalizeCycle(input)).toBe(expected);
  });

  it.each(['', '   ', '0', '13', 'XIII', 'VV', 'IIII', 'abc'])(
    'rechaza %j con un mensaje en español',
    (input) => {
      expect(() => normalizeCycle(input)).toThrow(BadRequestException);
      expect(() => normalizeCycle(input)).toThrow(/Ciclo inválido/);
    },
  );
});

describe('normalizeSection', () => {
  it.each([
    ['A1', 'A1'],
    ['a-1', 'A1'],
    ['a 1', 'A1'],
    ['sección A1', 'A1'],
    ['Sección b2', 'B2'],
    ['SECC. C', 'C'],
    [' b ', 'B'],
    ['a_2', 'A2'],
  ])('normaliza %j a %s', (input, expected) => {
    expect(normalizeSection(input)).toBe(expected);
  });

  it.each(['', '   ', '---', 'sección'])('rechaza %j por vacía', (input) => {
    expect(() => normalizeSection(input)).toThrow(BadRequestException);
    expect(() => normalizeSection(input)).toThrow(/Indica la sección/);
  });

  it('rechaza secciones demasiado largas', () => {
    expect(() => normalizeSection('ABCDEFGHIJK')).toThrow(/demasiado larga/);
  });
});

describe('groupLabel', () => {
  it('arma la etiqueta de un salón', () => {
    expect(groupLabel('Ingeniería de Sistemas', 'SECTION', 'V', 'A1')).toBe(
      'Ingeniería de Sistemas · V · A1',
    );
  });

  it('usa "Ciclo completo" para un ciclo', () => {
    expect(groupLabel('Ingeniería de Sistemas', 'CYCLE', 'V', '')).toBe(
      'Ingeniería de Sistemas · V · Ciclo completo',
    );
  });

  it('expone el valor de sección para equipos de ciclo completo', () => {
    expect(CYCLE_FULL_SECTION).toBe('CICLO COMPLETO');
  });
});
