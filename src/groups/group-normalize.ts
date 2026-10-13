import { BadRequestException } from '@nestjs/common';

/** Espejo del enum `GroupScope` de Prisma (SECTION = salón, CYCLE = ciclo completo). */
export type GroupScopeValue = 'SECTION' | 'CYCLE';

/** Valor que se guarda en `Team.section` para los equipos de un grupo de ciclo completo. */
export const CYCLE_FULL_SECTION = 'CICLO COMPLETO';

const ROMAN_CYCLES = [
  'I',
  'II',
  'III',
  'IV',
  'V',
  'VI',
  'VII',
  'VIII',
  'IX',
  'X',
  'XI',
  'XII',
];
const MAX_SECTION_LENGTH = 10;

function clean(input: string): string {
  // NFD separa las tildes en marcas combinantes (\p{M}) que luego se eliminan.
  return (input ?? '').normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();
}

/**
 * Normaliza el ciclo escrito a mano a número romano (I a XII): "5", "v", "ciclo V", "5to ciclo" → "V".
 */
export function normalizeCycle(input: string): string {
  const text = clean(input)
    .replace(/CICLO/g, '')
    .replace(/[^A-Z0-9]/g, '');
  const ordinal = /^(\d{1,2})(?:ER|RO|DO|TO|VO|MO|NO)?$/.exec(text);
  if (ordinal) {
    const index = Number(ordinal[1]);
    if (index >= 1 && index <= ROMAN_CYCLES.length) {
      return ROMAN_CYCLES[index - 1];
    }
  } else if (ROMAN_CYCLES.includes(text)) {
    return text;
  }
  throw new BadRequestException(
    'Ciclo inválido: usa un número del 1 al 12 o romanos (I a XII)',
  );
}

/**
 * Normaliza la sección (texto libre) a mayúsculas alfanuméricas sin espacios ni guiones:
 * "a-1", "a 1", "sección A1" → "A1".
 */
export function normalizeSection(input: string): string {
  const text = clean(input)
    .replace(/SECCION|SECC/g, '')
    .replace(/[^A-Z0-9]/g, '');
  if (!text) {
    throw new BadRequestException('Indica la sección del salón');
  }
  if (text.length > MAX_SECTION_LENGTH) {
    throw new BadRequestException(
      `La sección es demasiado larga (máximo ${MAX_SECTION_LENGTH} caracteres)`,
    );
  }
  return text;
}

/** Etiqueta legible del grupo, usada en listados y en `teamName` del Contrato 2. */
export function groupLabel(
  schoolName: string,
  scope: GroupScopeValue,
  cycle: string,
  section: string,
): string {
  return `${schoolName} · ${cycle} · ${scope === 'CYCLE' ? 'Ciclo completo' : section}`;
}
