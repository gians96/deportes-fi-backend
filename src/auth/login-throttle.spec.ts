import { HttpException, HttpStatus } from '@nestjs/common';
import { LoginThrottle } from './login-throttle';

const IP = '203.0.113.7';
const EMAIL = 'alumno@example.com';

function expectBlocked(throttle: LoginThrottle, ip = IP, email = EMAIL) {
  try {
    throttle.assertAllowed(ip, email);
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
    return;
  }
  throw new Error('Se esperaba un bloqueo 429');
}

describe('LoginThrottle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-14T10:00:00Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('permite hasta 5 fallos desde la misma IP contra el mismo correo y luego bloquea', () => {
    const throttle = new LoginThrottle();
    for (let i = 0; i < 5; i++) {
      throttle.assertAllowed(IP, EMAIL);
      throttle.recordFailure(IP, EMAIL);
    }
    expectBlocked(throttle);
  });

  it('el bloqueo no afecta a otra IP ni a otro correo', () => {
    const throttle = new LoginThrottle();
    for (let i = 0; i < 5; i++) throttle.recordFailure(IP, EMAIL);
    expect(() => throttle.assertAllowed('198.51.100.9', EMAIL)).not.toThrow();
    expect(() => throttle.assertAllowed(IP, 'otro@example.com')).not.toThrow();
  });

  it('ignora mayúsculas del correo', () => {
    const throttle = new LoginThrottle();
    for (let i = 0; i < 5; i++)
      throttle.recordFailure(IP, 'Alumno@Example.com');
    expectBlocked(throttle);
  });

  it('un acceso correcto reinicia el contador', () => {
    const throttle = new LoginThrottle();
    for (let i = 0; i < 4; i++) throttle.recordFailure(IP, EMAIL);
    throttle.recordSuccess(IP, EMAIL);
    for (let i = 0; i < 4; i++) throttle.recordFailure(IP, EMAIL);
    expect(() => throttle.assertAllowed(IP, EMAIL)).not.toThrow();
  });

  it('se libera al pasar la ventana de 15 minutos', () => {
    const throttle = new LoginThrottle();
    for (let i = 0; i < 5; i++) throttle.recordFailure(IP, EMAIL);
    expectBlocked(throttle);
    jest.setSystemTime(new Date('2026-10-14T10:14:59Z'));
    expectBlocked(throttle);
    jest.setSystemTime(new Date('2026-10-14T10:15:01Z'));
    expect(() => throttle.assertAllowed(IP, EMAIL)).not.toThrow();
  });

  it('cambiar de IP no evita el límite por correo (20 fallos desde cualquier IP)', () => {
    const throttle = new LoginThrottle();
    for (let i = 0; i < 20; i++) {
      throttle.recordFailure(`198.51.100.${i}`, EMAIL);
    }
    expectBlocked(throttle, '192.0.2.200', EMAIL);
  });
});
