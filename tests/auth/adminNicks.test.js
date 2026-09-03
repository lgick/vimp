import { parseAdminNicks, parseAdminIdentities } from '../../packages/auth/src/config/auth.js';

// VIMP_ADMIN_NICKS — источник истины ролей на этапе 1 направления
// master-game-registry: список сравнивается с ником в нижнем регистре, а
// пустая переменная означает «админов нет» и не должна ронять сервис
describe('parseAdminNicks', () => {
  it('разбирает список, приводя к нижнему регистру и обрезая пробелы', () => {
    expect(parseAdminNicks('lgick, Admin ,  Boss')).toEqual(['lgick', 'admin', 'boss']);
  });

  it('принимает одиночный ник и хвостовую запятую', () => {
    expect(parseAdminNicks('lgick')).toEqual(['lgick']);
    expect(parseAdminNicks('lgick,')).toEqual(['lgick']);
    expect(parseAdminNicks(',,lgick, ,')).toEqual(['lgick']);
  });

  it('пустое значение даёт пустой список (админов нет)', () => {
    expect(parseAdminNicks('')).toEqual([]);
    expect(parseAdminNicks('   ')).toEqual([]);
    expect(parseAdminNicks(undefined)).toEqual([]);
  });
});

// VIMP_ADMIN_IDENTITIES — приоритетный источник прав (провайдер:uid):
// незанятый ник из VIMP_ADMIN_NICKS достаётся первому, кто под ним
// зарегистрируется, а provider_uid принадлежит конкретному аккаунту
describe('parseAdminIdentities', () => {
  it('разбирает список, приводя к нижнему регистру и обрезая пробелы', () => {
    expect(parseAdminIdentities('github:123, GitHub:456 ')).toEqual([
      'github:123',
      'github:456',
    ]);
  });

  it('отбрасывает мусор без двоеточия и с лишним двоеточием', () => {
    expect(parseAdminIdentities('lgick,github:123,github:4:5,:,github:')).toEqual([
      'github:123',
    ]);
  });

  it('пустое значение даёт пустой список (переменная не задана)', () => {
    expect(parseAdminIdentities('')).toEqual([]);
    expect(parseAdminIdentities('  ,  ')).toEqual([]);
    expect(parseAdminIdentities(undefined)).toEqual([]);
  });
});
