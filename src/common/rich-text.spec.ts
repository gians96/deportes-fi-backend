import { BadRequestException } from '@nestjs/common';
import { RICH_TEXT_MAX_BYTES, sanitizeRichText } from './rich-text';

describe('sanitizeRichText', () => {
  it('devuelve null si el texto está vacío o solo tiene etiquetas vacías', () => {
    expect(sanitizeRichText(undefined)).toBeNull();
    expect(sanitizeRichText('   ')).toBeNull();
    expect(sanitizeRichText('<p></p>')).toBeNull();
    expect(sanitizeRichText('<p>&nbsp;</p>')).toBeNull();
  });

  it('conserva el formato permitido y quita lo peligroso', () => {
    const html = sanitizeRichText(
      '<p onclick="x()">Hola <strong>mundo</strong><script>alert(1)</script></p>',
    );
    expect(html).toBe('<p>Hola <strong>mundo</strong></p>');
  });

  it('abre los enlaces en otra pestaña y sin referrer', () => {
    const html = sanitizeRichText('<a href="https://undc.edu.pe">UNDC</a>');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  describe('límite de tamaño de la columna TEXT', () => {
    const wrap = (inner: string) => `<p>${inner}</p>`;

    it('acepta un texto justo en el límite', () => {
      const overhead = Buffer.byteLength(wrap(''), 'utf8');
      const text = wrap('a'.repeat(RICH_TEXT_MAX_BYTES - overhead));
      expect(Buffer.byteLength(text, 'utf8')).toBe(RICH_TEXT_MAX_BYTES);
      expect(sanitizeRichText(text)).toBe(text);
    });

    it('rechaza con 400 (no 500) un texto que no cabe', () => {
      const text = wrap('a'.repeat(RICH_TEXT_MAX_BYTES + 1));
      expect(() => sanitizeRichText(text)).toThrow(BadRequestException);
    });

    it('cuenta bytes y no caracteres: 31 000 tildes superan el límite', () => {
      const text = wrap('á'.repeat(31_000));
      expect(text.length).toBeLessThan(RICH_TEXT_MAX_BYTES);
      expect(() => sanitizeRichText(text)).toThrow(BadRequestException);
    });

    it('el mensaje nombra el campo y da el tamaño y el máximo', () => {
      const text = wrap('a'.repeat(70_000));
      let message = '';
      try {
        sanitizeRichText(text, 'las bases');
      } catch (error) {
        message = (error as BadRequestException).message;
      }
      expect(message).toBe(
        'El texto de las bases es demasiado largo (70.0 KB; el máximo es 60.0 KB). Acórtalo e inténtalo de nuevo.',
      );
    });

    it('mide el texto ya limpio: las etiquetas no permitidas no cuentan', () => {
      const scripts = '<script>'.concat('x'.repeat(70_000), '</script>');
      expect(sanitizeRichText(`<p>Hola</p>${scripts}`)).toBe('<p>Hola</p>');
    });
  });
});
