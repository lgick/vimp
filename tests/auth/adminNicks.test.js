import { parseAdminNicks } from '../../packages/auth/src/config/auth.js';

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
