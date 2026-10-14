import { BadRequestException } from '@nestjs/common';
import sanitizeHtml from 'sanitize-html';

const EMPTY_HTML_RE = /<[^>]*>/g;

/**
 * Tamaño máximo (bytes UTF-8) de un texto con formato. Se guarda en una columna TEXT de MySQL, que admite
 * 65 535 bytes: lo que no cabe hacía fallar el INSERT y la API respondía 500. Se deja margen y se avisa con
 * un 400 claro. El frontend usa el mismo valor (`RICH_TEXT_MAX_BYTES` en `utils/richText.ts`).
 */
export const RICH_TEXT_MAX_BYTES = 60_000;

/**
 * Limpia un texto con formato (solo etiquetas y enlaces permitidos). Devuelve `null` si queda vacío y lanza
 * 400 si, ya limpio, no cabe en la columna. `label` nombra el campo con su artículo en minúscula
 * («las bases») y entra en el mensaje: «El texto de las bases es demasiado largo…».
 */
export function sanitizeRichText(value?: string | null, label = 'este campo') {
  if (!value?.trim()) return null;

  const sanitized = sanitizeHtml(value, {
    allowedTags: [
      'p',
      'br',
      'strong',
      'em',
      'u',
      'h2',
      'h3',
      'ul',
      'ol',
      'li',
      'blockquote',
      'a',
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: (_tagName, attribs) => ({
        tagName: 'a',
        attribs: {
          href: attribs.href,
          target: '_blank',
          rel: 'noopener noreferrer',
        },
      }),
    },
  }).trim();

  const textOnly = sanitized
    .replace(/&nbsp;/g, ' ')
    .replace(EMPTY_HTML_RE, '')
    .trim();

  if (!textOnly) return null;

  const bytes = Buffer.byteLength(sanitized, 'utf8');
  if (bytes > RICH_TEXT_MAX_BYTES) {
    const kb = (value: number) => (value / 1000).toFixed(1);
    throw new BadRequestException(
      `El texto de ${label} es demasiado largo (${kb(bytes)} KB; el máximo es ${kb(RICH_TEXT_MAX_BYTES)} KB). Acórtalo e inténtalo de nuevo.`,
    );
  }
  return sanitized;
}
